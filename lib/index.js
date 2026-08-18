// vision-bridge — host-level vision plugin for DeepSeek Harness.
// Registered as a profile bundle; survives dsh restarts.
// Host plugins run in the full Node runtime: uses native fetch + node:fs,
// no dependency on agent-scoped services (fs/subprocess/sandboxPolicy).
//
// Config priority (low → high):
//   VISION_DEFAULTS → cordis.yml plugin config (Config schema) → workspace dsh-vision-config.json
// The JSON file exists for runtime hot-switching of backends (agent may edit it).
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { resolve as pathResolve, isAbsolute } from 'node:path'
import {
  VISION_DEFAULTS,
  VISION_BACKENDS,
  VISION_JSON_SCHEMA,
  bytesToBase64,
  mimeForPath,
  isXiaomi,
  isLocalHost,
  resolveBaseUrl,
  extractJson,
  normalizeEvidence,
  mergeVisionConfig,
  readVisionConfigFile,
} from './pure.js'

export const name = 'vision-bridge'

export const inject = ['tools', 'systemPrompt', 'credentials']

// Cordis/Schemastery config schema: the official configuration surface.
// Values set here are the base layer; a workspace dsh-vision-config.json can
// still override them at runtime (hot backend switching).
// keepAlive / structuredOutput stay JSON-file-only (they are backend-runtime
// toggles, see README "配置字段速查").
export const Config = Schema.object({
  backend: Schema.string().default('custom'),
  baseUrl: Schema.string().default('http://localhost:11434/v1'),
  model: Schema.string().default('auto'),
  apiKeyRef: Schema.string().default('VISION_API_KEY'),
  timeoutMs: Schema.number().default(300000),
  maxTokens: Schema.number().default(8192),
  maxBytes: Schema.number().default(8 * 1024 * 1024),
  authStyle: Schema.union(['auto', 'bearer', 'api-key']).default('auto'),
  allowPrivateHosts: Schema.boolean().default(false),
  configFile: Schema.string().default('dsh-vision-config.json'),
})

// ---------------------------------------------------------------------------
// Plugin body
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const tools = ctx.tools
  const credentials = ctx.credentials
  const systemPrompt = ctx.systemPrompt
  const baseConfig = config !== null && typeof config === 'object' ? config : {}

  const detectCache = { baseUrl: '', model: '', at: 0 }

  const JSON_TEMPLATE = '{"summary":"一句话总结","ocr":{"full_text":"图中全部文字的完整转录","lines":[{"text":"逐行/逐段文字"}]},"layout":{"regions":[{"type":"title|heading|paragraph|list|table|chart|form|code|image|icon|link|nav|button|search 等","reading_order":1,"text":"该区域文字"}]},"semantics":{"scene":"场景/主体描述","entities":[{"name":"实体名","type":"person|object|text|brand|number 等","evidence":"图中依据"}]},"visual":{"dominant_colors":["主色"],"style":"视觉风格"},"uncertainty":["无法确定或可能出错的地方"]}'

  function sessionCwd(exec) {
    try {
      const h = exec.agent && exec.agent.session && exec.agent.session.header
      return h !== undefined && typeof h.cwd === 'string' && h.cwd !== '' ? h.cwd : undefined
    } catch (err) {
      return undefined
    }
  }

  function buildVisionPrompt(question) {
    const base = typeof question === 'string' && question.trim() !== '' ? question.trim() : '请提取这张图片中的全部可见信息（文字、布局、场景、实体），并回答针对图片的问题。'
    return base + '\n\n请以严格的 JSON 对象输出识别结果，不要输出 JSON 以外的任何文字。结构如下（顶层字段全部必填；可选字段没有内容就省略该键，不要写 null）：\n' + JSON_TEMPLATE
  }

  async function httpJson(method, url, opts, exec) {
    const o = opts === undefined ? {} : opts
    const timeoutMs = o.timeoutMs === undefined ? 60000 : o.timeoutMs
    const headers = { 'Content-Type': 'application/json' }
    if (typeof o.authHeader === 'string' && o.authHeader !== '') {
      const idx = o.authHeader.indexOf(':')
      if (idx > 0) {
        headers[o.authHeader.slice(0, idx).trim()] = o.authHeader.slice(idx + 1).trim()
      }
    }
    let resp
    try {
      const signal = exec !== undefined ? AbortSignal.any([exec.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
      resp = await fetch(url, {
        method: method,
        headers: headers,
        body: method === 'POST' && o.stdin !== undefined ? o.stdin : undefined,
        signal: signal,
      })
    } catch (err) {
      const e = new Error('HTTP 请求失败: ' + err.message)
      e.retryable = true
      throw e
    }
    const text = await resp.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      const e = new Error('无法解析 HTTP 响应（非 JSON, status ' + resp.status + '）: ' + String(text).slice(0, 300))
      e.retryable = true
      throw e
    }
    return parsed
  }

  async function detectVisionModel(baseUrl, exec, timeoutMs) {
    const now = Date.now()
    if (detectCache.baseUrl === baseUrl && now - detectCache.at < 60000) return detectCache.model
    const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
    let parsed
    try {
      parsed = await httpJson('GET', root + '/api/tags', { timeoutMs: Math.min(timeoutMs, 30000) }, exec)
    } catch (err) {
      throw new Error('自动选择视觉模型失败（无法访问 ' + root + '/api/tags）: ' + err.message + '。请在配置中显式设置 "model"（云端 API 不支持 auto）。')
    }
    const models = Array.isArray(parsed.models) ? parsed.models : []
    const isVision = function (m) {
      const caps = Array.isArray(m.capabilities) ? m.capabilities : []
      if (caps.some(function (c) { return typeof c === 'string' && /vision|image/i.test(c) })) return true
      return /vl|vision|llava|moondream|minicpm|ocr/i.test(String(m.name || ''))
    }
    const visionModels = models.filter(isVision)
    if (visionModels.length === 0) {
      throw new Error('Ollama 中没有找到视觉模型（如 qwen3-vl、minicpm-v、llava 等）。请先 ollama pull 一个视觉模型，或在配置中设置 "model"。')
    }
    const rank = function (name) {
      const n = String(name || '').toLowerCase()
      if (/qwen3-vl/.test(n)) return 0
      if (/minicpm/.test(n)) return 1
      if (/qwen2\.5.*vl/.test(n) || /qwen3\.5/.test(n)) return 2
      if (/llava|moondream/.test(n)) return 3
      if (/glm.*ocr/.test(n)) return 4
      if (/gemma/.test(n)) return 5
      return 6
    }
    visionModels.sort(function (a, b) { return rank(a.name) - rank(b.name) })
    const result = String(visionModels[0].name || visionModels[0].model || '')
    detectCache.baseUrl = baseUrl
    detectCache.model = result
    detectCache.at = now
    return result
  }

  async function analyzeImage(args, exec) {
    let apiKey
    try {
      const cwd = sessionCwd(exec)
      const fileConfig = await readVisionConfigFile(cwd, baseConfig.configFile)
      const cfg = mergeVisionConfig(baseConfig, fileConfig)
      cfg.baseUrl = resolveBaseUrl(cfg.baseUrl, cfg.allowPrivateHosts === true)
      const image = String(args.image || '').trim()
      if (image === '') throw new Error('缺少 image 参数：请提供图片文件路径或 http(s) 图片链接。')
      const question = typeof args.question === 'string' && args.question.trim() !== '' ? args.question.trim() : ''
      let imageUrl
      if (/^https?:\/\//i.test(image)) {
        imageUrl = image
      } else {
        let filePath = image
        if (!isAbsolute(filePath) && cwd !== undefined) filePath = pathResolve(cwd, filePath)
        let bytes
        try {
          bytes = new Uint8Array(await readFile(filePath))
        } catch (err) {
          throw new Error('读取图片失败（文件不存在或不可读: ' + filePath + '）: ' + err.message)
        }
        if (bytes.length > cfg.maxBytes) {
          throw new Error('读取图片失败：图片 ' + Math.round(bytes.length / 1048576) + 'MB 超过上限 ' + Math.round(cfg.maxBytes / 1048576) + 'MB（可编辑配置的 maxBytes 调整，或先压缩图片）')
        }
        imageUrl = 'data:' + mimeForPath(image) + ';base64,' + bytesToBase64(bytes)
      }
      const apiKeyRef = typeof cfg.apiKeyRef === 'string' ? cfg.apiKeyRef : ''
      if (apiKeyRef !== '') {
        if (credentials !== undefined) {
          try {
            const cred = await credentials.resolve(apiKeyRef)
            if (cred !== undefined && typeof cred.value === 'string' && cred.value !== '') apiKey = cred.value
          } catch (err) {
            /* ignore */
          }
        }
        if (apiKey === undefined && typeof process !== 'undefined' && process.env !== undefined) {
          const fromEnv = process.env[apiKeyRef]
          if (typeof fromEnv === 'string' && fromEnv !== '') apiKey = fromEnv
        }
      }
      let model = typeof cfg.model === 'string' && cfg.model !== '' ? cfg.model : 'auto'
      const base = String(cfg.baseUrl || VISION_DEFAULTS.baseUrl).replace(/\/+$/, '')
      if (model === 'auto') model = await detectVisionModel(base, exec, cfg.timeoutMs)

      const authStyle = cfg.authStyle === 'api-key' || cfg.authStyle === 'bearer' ? cfg.authStyle : (isXiaomi(base) ? 'api-key' : 'bearer')
      const maxTokens = typeof cfg.maxTokens === 'number' && cfg.maxTokens > 0 ? cfg.maxTokens : VISION_DEFAULTS.maxTokens
      let authHeader = ''
      if (apiKey !== undefined && apiKey !== '') {
        authHeader = authStyle === 'api-key' ? 'api-key: ' + apiKey : 'Authorization: Bearer ' + apiKey
      }

      let useSchema = isLocalHost(base) && cfg.structuredOutput !== false
      async function post() {
        const b = {
          model: model,
          messages: [{ role: 'user', content: [{ type: 'text', text: buildVisionPrompt(question) }, { type: 'image_url', image_url: { url: imageUrl } }] }],
          stream: false,
        }
        b[isXiaomi(base) ? 'max_completion_tokens' : 'max_tokens'] = maxTokens
        if (isLocalHost(base) && cfg.keepAlive !== false) {
          b.keep_alive = typeof cfg.keepAlive === 'string' && cfg.keepAlive !== '' ? cfg.keepAlive : '30m'
        }
        if (useSchema) {
          b.response_format = { type: 'json_schema', json_schema: { name: 'vision_evidence', schema: VISION_JSON_SCHEMA } }
        }
        return httpJson('POST', base + '/chat/completions', { stdin: JSON.stringify(b), authHeader: authHeader, timeoutMs: cfg.timeoutMs }, exec)
      }

      let parsed
      try {
        parsed = await post()
      } catch (err) {
        if (err.retryable !== true) throw err
        parsed = await post()
      }
      if (parsed.error !== undefined && parsed.error !== null && useSchema) {
        useSchema = false
        parsed = await post()
      }
      if (parsed.error !== undefined && parsed.error !== null) {
        const detail = typeof parsed.error === 'object' ? JSON.stringify(parsed.error) : String(parsed.error)
        throw new Error('视觉 API 返回错误: ' + detail.slice(0, 500))
      }
      const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined
      const message = choice === undefined ? undefined : choice.message
      const content = message === undefined ? undefined : message.content
      const reasoning = message === undefined ? undefined : (message.reasoning || message.reasoning_content)
      const rawText = typeof content === 'string' && content.trim() !== '' ? content : (typeof reasoning === 'string' ? reasoning : '')
      if (rawText === '') {
        throw new Error('视觉模型未返回有效内容: ' + JSON.stringify(parsed).slice(0, 400))
      }
      const extracted = extractJson(rawText)
      const evidence = normalizeEvidence(extracted)
      evidence.model = String(parsed.model || model)
      if (extracted === null) {
        evidence.uncertainty.push('视觉模型未按结构化 JSON 格式输出，以上字段为降级提取')
      }
      return evidence
    } catch (err) {
      if (apiKey !== undefined && apiKey !== '' && err instanceof Error && typeof err.message === 'string') {
        err.message = err.message.split(apiKey).join('[REDACTED]')
      }
      throw err
    }
  }

  const tool = defineTool({
    name: 'analyze_image',
    description: '识别并提取一张图片的结构化证据（本地图片文件路径或 http(s) 图片链接）。主模型不支持直接看图，调用此工具会把图片发送给配置的视觉模型（默认本机 Ollama，可切换小米 MiMo 云端），返回结构化 JSON 证据：summary（总结）、ocr（全文转录与逐行文字）、layout（按阅读顺序的版面区块）、semantics（场景与实体）、visual（配色与风格）、uncertainty（不确定项）。回答时引用证据内容而非凭空猜测。后端在配置的 backend 字段快速切换："ollama" 或 "xiaomi"；省略或 "custom" 使用显式 baseUrl/model/apiKeyRef。当用户要求查看、识别、分析或描述图片、截图、图表时使用。',
    parameters: {
      image: { type: 'string', required: true, description: '图片路径：工作区内的文件路径（相对或绝对），或 http(s):// 开头的图片链接。' },
      question: { type: 'string', description: '关于图片的具体问题（可选，将作为识别的聚焦方向）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: '一句话总结图片内容。' },
          model: { type: 'string', description: '实际使用的视觉模型名称。' },
          ocr: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              full_text: { type: 'string', required: true, description: '图中全部文字的完整转录。' },
              lines: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { text: { type: 'string', required: true, description: '一行/一段文字。' } },
                },
              },
            },
          },
          layout: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              regions: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    type: { type: 'string', required: true, description: '区域类型：title/heading/paragraph/list/table/chart/form/code/image/icon/link/nav/button/search 等。' },
                    reading_order: { type: 'number', required: true, description: '按阅读顺序的序号。' },
                    text: { type: 'string', required: true, description: '该区域文字。' },
                  },
                },
              },
            },
          },
          semantics: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              scene: { type: 'string', required: true, description: '场景/主体描述。' },
              entities: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', required: true, description: '实体名。' },
                    type: { type: 'string', required: true, description: '实体类型：person/object/text/brand/number 等。' },
                  },
                },
              },
            },
          },
          visual: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              dominant_colors: { type: 'array', items: { type: 'string' }, description: '主色调。' },
              style: { type: 'string', description: '视觉风格。' },
            },
          },
          uncertainty: { type: 'array', required: true, items: { type: 'string' }, description: '不确定或可能出错之处。' },
        },
      },
      render: function (args, value) {
        const v = value !== null && typeof value === 'object' ? value : {}
        const parts = ['[图像识别 · ' + (typeof v.model === 'string' ? v.model : 'unknown') + ']']
        if (typeof v.summary === 'string' && v.summary !== '') parts.push('总结: ' + v.summary)
        if (v.ocr !== null && typeof v.ocr === 'object' && typeof v.ocr.full_text === 'string' && v.ocr.full_text !== '') {
          parts.push('文字: ' + v.ocr.full_text.slice(0, 500))
        }
        if (v.semantics !== null && typeof v.semantics === 'object' && typeof v.semantics.scene === 'string' && v.semantics.scene !== '') {
          parts.push('场景: ' + v.semantics.scene)
        }
        if (Array.isArray(v.uncertainty) && v.uncertainty.length > 0) {
          parts.push('不确定: ' + v.uncertainty.join('; ').slice(0, 300))
        }
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args, exec) {
      return await analyzeImage(args, exec)
    },
  })

  // tools.register returns a Cordis effect disposer: the registration is
  // automatically reverted when this plugin unloads — no manual cleanup needed.
  tools.register(tool)

  if (systemPrompt !== undefined) {
    try {
      systemPrompt.section({
        name: 'tool:analyze-image',
        order: 105,
        text: '本会话的主模型无法直接查看图片。当用户要求查看、识别、描述或分析一张图片（给出文件路径或链接，或提到某张图片/截图/图表）时，必须调用 analyze_image 工具获取图片的结构化证据（OCR 全文、版面、场景、实体、不确定项），然后基于证据回答用户，引用具体内容而非凭空猜测。视觉后端可通过配置的 backend 字段在本地 Ollama（"ollama"）与小米 MiMo 云端（"xiaomi"）之间快速切换。',
      })
    } catch (err) {
      console.error('[vision-bridge] systemPrompt section failed (non-fatal): ' + err.message)
    }
  }
  console.log('[vision-bridge] host-level analyze_image tool registered (native fetch + node:fs)')
}
