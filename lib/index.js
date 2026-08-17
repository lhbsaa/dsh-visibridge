// vision-bridge — host-level vision plugin for DeepSeek Harness.
// Registered as a profile bundle; survives dsh restarts.
// Host plugins run in the full Node runtime: uses native fetch + node:fs,
// no dependency on agent-scoped services (fs/subprocess/sandboxPolicy).
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile } from 'node:fs/promises'
import { resolve as pathResolve, isAbsolute } from 'node:path'

export const name = 'vision-bridge'

export const inject = ['tools', 'systemPrompt', 'credentials']

export function apply(ctx) {
  const tools = ctx.tools
  const credentials = ctx.credentials
  const systemPrompt = ctx.systemPrompt

  const DEFAULTS = {
    baseUrl: 'http://localhost:11434/v1',
    model: 'auto',
    apiKeyRef: 'VISION_API_KEY',
    timeoutMs: 300000,
    maxTokens: 8192,
    maxBytes: 8 * 1024 * 1024,
    authStyle: undefined,
    keepAlive: undefined,
    structuredOutput: undefined,
  }

  const BACKENDS = {
    ollama: { baseUrl: 'http://localhost:11434/v1', model: 'auto', apiKeyRef: 'VISION_API_KEY' },
    xiaomi: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5', apiKeyRef: 'XIAOMI_MIMO_API_KEY' },
  }

  const detectCache = { baseUrl: '', model: '', at: 0 }

  const VISION_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'ocr', 'layout', 'semantics', 'visual', 'uncertainty'],
    properties: {
      summary: { type: 'string' },
      ocr: {
        type: 'object',
        additionalProperties: false,
        required: ['full_text', 'lines'],
        properties: {
          full_text: { type: 'string' },
          lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } } },
        },
      },
      layout: {
        type: 'object',
        additionalProperties: false,
        required: ['regions'],
        properties: {
          regions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'reading_order', 'text'],
              properties: { type: { type: 'string' }, reading_order: { type: 'integer' }, text: { type: 'string' } },
            },
          },
        },
      },
      semantics: {
        type: 'object',
        additionalProperties: false,
        required: ['scene', 'entities'],
        properties: {
          scene: { type: 'string' },
          entities: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['name', 'type'], properties: { name: { type: 'string' }, type: { type: 'string' } } },
          },
        },
      },
      visual: {
        type: 'object',
        additionalProperties: false,
        properties: { dominant_colors: { type: 'array', items: { type: 'string' } }, style: { type: 'string' } },
      },
      uncertainty: { type: 'array', items: { type: 'string' } },
    },
  }

  function sessionCwd(exec) {
    try {
      const h = exec.agent && exec.agent.session && exec.agent.session.header
      return h !== undefined && typeof h.cwd === 'string' && h.cwd !== '' ? h.cwd : undefined
    } catch (err) {
      return undefined
    }
  }

  function isXiaomi(baseUrl) {
    return /xiaomimimo\.com/i.test(String(baseUrl))
  }

  function isLocalHost(baseUrl) {
    return /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(String(baseUrl))
  }

  async function readConfig(cwd) {
    const candidates = []
    if (cwd !== undefined) candidates.push(pathResolve(cwd, 'dsh-vision-config.json'))
    candidates.push(pathResolve(process.cwd(), 'dsh-vision-config.json'))
    let parsed = {}
    for (const path of candidates) {
      try {
        const text = await readFile(path, 'utf8')
        parsed = JSON.parse(text)
        break
      } catch (err) {
        // try next candidate
      }
    }
    let result = Object.assign({}, DEFAULTS, parsed)
    const backendName = typeof parsed.backend === 'string' ? parsed.backend : ''
    if (backendName !== '' && backendName !== 'custom' && Object.prototype.hasOwnProperty.call(BACKENDS, backendName)) {
      const explicitModel = typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : undefined
      result = Object.assign(result, BACKENDS[backendName])
      if (explicitModel !== undefined) result.model = explicitModel
    }
    return result
  }

  const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  function bytesToBase64(bytes) {
    let out = ''
    const len = bytes.length
    for (let i = 0; i < len; i += 3) {
      const b0 = bytes[i]
      const b1 = i + 1 < len ? bytes[i + 1] : -1
      const b2 = i + 2 < len ? bytes[i + 2] : -1
      out += B64_CHARS[b0 >> 2]
      out += B64_CHARS[((b0 & 3) << 4) | (b1 >= 0 ? b1 >> 4 : 0)]
      out += b1 >= 0 ? B64_CHARS[((b1 & 15) << 2) | (b2 >= 0 ? b2 >> 6 : 0)] : '='
      out += b2 >= 0 ? B64_CHARS[b2 & 63] : '='
    }
    return out
  }

  function mimeForPath(path) {
    const parts = String(path).split('.')
    const ext = (parts.length > 1 ? parts[parts.length - 1] : '').toLowerCase()
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    if (ext === 'webp') return 'image/webp'
    if (ext === 'gif') return 'image/gif'
    if (ext === 'bmp') return 'image/bmp'
    return 'image/png'
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
      throw new Error('自动选择视觉模型失败（无法访问 ' + root + '/api/tags）: ' + err.message + '。请在 dsh-vision-config.json 中显式设置 "model"（云端 API 不支持 auto）。')
    }
    const models = Array.isArray(parsed.models) ? parsed.models : []
    const isVision = function (m) {
      const caps = Array.isArray(m.capabilities) ? m.capabilities : []
      if (caps.some(function (c) { return typeof c === 'string' && /vision|image/i.test(c) })) return true
      return /vl|vision|llava|moondream|minicpm|ocr/i.test(String(m.name || ''))
    }
    const visionModels = models.filter(isVision)
    if (visionModels.length === 0) {
      throw new Error('Ollama 中没有找到视觉模型（如 qwen3-vl、minicpm-v、llava 等）。请先 ollama pull 一个视觉模型，或在 dsh-vision-config.json 中设置 "model"。')
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

  const JSON_TEMPLATE = '{"summary":"一句话总结","ocr":{"full_text":"图中全部文字的完整转录","lines":[{"text":"逐行/逐段文字"}]},"layout":{"regions":[{"type":"title|heading|paragraph|list|table|chart|form|code|image|icon|link|nav|button|search 等","reading_order":1,"text":"该区域文字"}]},"semantics":{"scene":"场景/主体描述","entities":[{"name":"实体名","type":"person|object|text|brand|number 等","evidence":"图中依据"}]},"visual":{"dominant_colors":["主色"],"style":"视觉风格"},"uncertainty":["无法确定或可能出错的地方"]}'

  function buildVisionPrompt(question) {
    const base = typeof question === 'string' && question.trim() !== '' ? question.trim() : '请提取这张图片中的全部可见信息（文字、布局、场景、实体），并回答针对图片的问题。'
    return base + '\n\n请以严格的 JSON 对象输出识别结果，不要输出 JSON 以外的任何文字。结构如下（顶层字段全部必填；可选字段没有内容就省略该键，不要写 null）：\n' + JSON_TEMPLATE
  }

  function extractJson(text) {
    if (typeof text !== 'string') return null
    const trimmed = text.trim()
    if (trimmed === '') return null
    const candidates = [trimmed]
    const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
    if (m !== null) candidates.push(m[1].trim())
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
    for (const candidate of candidates) {
      try { return JSON.parse(candidate) } catch (err) { /* fall through */ }
      try { return JSON.parse(candidate.replace(/,([\s]*[}\]])/g, '$1')) } catch (err) { /* fall through */ }
    }
    return null
  }

  function str(v, d) { return typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean' ? String(v) : d) }
  function arr(v) { return Array.isArray(v) ? v : [] }

  function normalizeEvidence(raw) {
    const o = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const ocrRaw = o.ocr !== null && typeof o.ocr === 'object' ? o.ocr : {}
    const fullText = str(ocrRaw.full_text, '')
    const lines = arr(ocrRaw.lines).filter(function (l) { return l !== null && typeof l === 'object' && typeof l.text === 'string' }).map(function (l) { return { text: l.text } })
    if (lines.length === 0 && fullText !== '') lines.push({ text: fullText })
    const layoutRaw = o.layout !== null && typeof o.layout === 'object' ? o.layout : {}
    const regions = arr(layoutRaw.regions).filter(function (r) { return r !== null && typeof r === 'object' }).map(function (r) {
      return { type: str(r.type, 'content'), reading_order: typeof r.reading_order === 'number' ? r.reading_order : 0, text: str(r.text, '') }
    })
    const semRaw = o.semantics !== null && typeof o.semantics === 'object' ? o.semantics : {}
    const entities = arr(semRaw.entities).filter(function (e) { return e !== null && typeof e === 'object' }).map(function (e) {
      return { name: str(e.name, '?'), type: str(e.type, 'unknown') }
    })
    const visualRaw = o.visual !== null && typeof o.visual === 'object' ? o.visual : {}
    const summaryFallback = fullText !== '' ? fullText.slice(0, 200) : '图片内容描述'
    return {
      summary: str(o.summary, summaryFallback),
      ocr: { full_text: fullText, lines: lines },
      layout: { regions: regions },
      semantics: { scene: str(semRaw.scene, ''), entities: entities },
      visual: {
        dominant_colors: arr(visualRaw.dominant_colors).filter(function (v) { return typeof v === 'string' }),
        style: str(visualRaw.style, ''),
      },
      uncertainty: arr(o.uncertainty).filter(function (v) { return typeof v === 'string' }),
    }
  }

  async function analyzeImage(args, exec) {
    let apiKey
    try {
      const cwd = sessionCwd(exec)
      const cfg = await readConfig(cwd)
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
          throw new Error('读取图片失败：图片 ' + Math.round(bytes.length / 1048576) + 'MB 超过上限 ' + Math.round(cfg.maxBytes / 1048576) + 'MB（可编辑 dsh-vision-config.json 的 maxBytes 调整，或先压缩图片）')
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
      const base = String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '')
      if (model === 'auto') model = await detectVisionModel(base, exec, cfg.timeoutMs)

      const authStyle = cfg.authStyle === 'api-key' || cfg.authStyle === 'bearer' ? cfg.authStyle : (isXiaomi(base) ? 'api-key' : 'bearer')
      const maxTokens = typeof cfg.maxTokens === 'number' && cfg.maxTokens > 0 ? cfg.maxTokens : DEFAULTS.maxTokens
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
    description: '识别并提取一张图片的结构化证据（本地图片文件路径或 http(s) 图片链接）。主模型不支持直接看图，调用此工具会把图片发送给配置的视觉模型（默认本机 Ollama，可切换小米 MiMo 云端），返回结构化 JSON 证据：summary（总结）、ocr（全文转录与逐行文字）、layout（按阅读顺序的版面区块）、semantics（场景与实体）、visual（配色与风格）、uncertainty（不确定项）。回答时引用证据内容而非凭空猜测。后端在 dsh-vision-config.json 的 backend 字段快速切换："ollama" 或 "xiaomi"；省略或 "custom" 使用显式 baseUrl/model/apiKeyRef。当用户要求查看、识别、分析或描述图片、截图、图表时使用。',
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

  const disposeTool = tools.register(tool)
  ctx.on('dispose', () => {
    try {
      disposeTool()
    } catch (err) {
      /* ignore */
    }
  })

  if (systemPrompt !== undefined) {
    try {
      systemPrompt.section({
        name: 'tool:analyze-image',
        order: 105,
        text: '本会话的主模型无法直接查看图片。当用户要求查看、识别、描述或分析一张图片（给出文件路径或链接，或提到某张图片/截图/图表）时，必须调用 analyze_image 工具获取图片的结构化证据（OCR 全文、版面、场景、实体、不确定项），然后基于证据回答用户，引用具体内容而非凭空猜测。视觉后端可通过 dsh-vision-config.json 的 backend 字段在本地 Ollama（"ollama"）与小米 MiMo 云端（"xiaomi"）之间快速切换。',
      })
    } catch (err) {
      console.error('[vision-bridge] systemPrompt section failed (non-fatal): ' + err.message)
    }
  }
  console.log('[vision-bridge] host-level analyze_image tool registered (native fetch + node:fs)')
}
