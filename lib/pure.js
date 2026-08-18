// vision-bridge — pure helpers, zero runtime dependencies.
// Kept separate from index.js so unit tests can import them without
// the @deepseek-ai runtime packages.
import { readFile } from 'node:fs/promises'
import { resolve as pathResolve } from 'node:path'

export const VISION_DEFAULTS = {
  backend: 'custom',
  baseUrl: 'http://localhost:11434/v1',
  model: 'auto',
  apiKeyRef: 'VISION_API_KEY',
  timeoutMs: 300000,
  maxTokens: 8192,
  maxBytes: 8 * 1024 * 1024,
  authStyle: 'auto',
  keepAlive: undefined,
  structuredOutput: undefined,
  allowPrivateHosts: false,
  configFile: 'dsh-vision-config.json',
}

export const VISION_BACKENDS = {
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'auto', apiKeyRef: 'VISION_API_KEY' },
  xiaomi: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5', apiKeyRef: 'XIAOMI_MIMO_API_KEY' },
}

export const VISION_JSON_SCHEMA = {
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

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Hand-written base64: the harness `btoa` uses UTF-8 text semantics and corrupts binary data. */
export function bytesToBase64(bytes) {
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

export function mimeForPath(path) {
  const parts = String(path).split('.')
  const ext = (parts.length > 1 ? parts[parts.length - 1] : '').toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  return 'image/png'
}

export function isXiaomi(baseUrl) {
  return /xiaomimimo\.com/i.test(String(baseUrl))
}

export function isLocalHost(baseUrl) {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(String(baseUrl))
}

/** RFC1918 / link-local / CGNAT / multicast / .local — blocked unless allowPrivateHosts. */
export function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (h === '') return false
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true
  if (/\.local$/.test(h)) return true
  if (h.indexOf(':') >= 0) {
    // IPv6: loopback / unspecified / ULA / link-local
    if (h === '::' || h === '::1') return true
    if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true
    return false
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (ipv4 !== null) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 0) return true
    if (a >= 224) return true
  }
  return false
}

/**
 * Validate a vision endpoint URL before use.
 * Default policy: allow localhost (local Ollama), known vendors (Xiaomi MiMo),
 * and public hosts; reject private/reserved addresses unless allowPrivate is set.
 */
export function resolveBaseUrl(raw, allowPrivate) {
  const value = String(raw || '').trim()
  if (value === '') throw new Error('baseUrl 不能为空，请在配置中设置 baseUrl')
  if (!/^https?:\/\//i.test(value)) throw new Error('baseUrl 必须以 http(s):// 开头: ' + value)
  if (allowPrivate === true) return value
  if (isLocalHost(value)) return value
  const m = /^https?:\/\/([^:\/\[\]\s]+)/i.exec(value)
  const host = m === null ? '' : m[1]
  if (host === '') throw new Error('无法解析 baseUrl 的主机名: ' + value)
  if (/xiaomimimo\.com$/i.test(host)) return value // known vendor endpoint
  if (isPrivateHost(host)) {
    throw new Error('baseUrl 指向内网/保留地址（' + host + '）。为防数据外泄与 SSRF，默认拒绝；如确需访问请在配置中设置 allowPrivateHosts: true')
  }
  return value
}

function str(v, d) { return typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean' ? String(v) : d) }
function arr(v) { return Array.isArray(v) ? v : [] }

/** Tolerant JSON extraction: code fences, bracket slicing, trailing commas. */
export function extractJson(text) {
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

/** Normalize raw model output into the guaranteed evidence shape. */
export function normalizeEvidence(raw) {
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

/**
 * Merge config layers: VISION_DEFAULTS ← cordis.yml config ← workspace JSON.
 * A `backend` preset ("ollama"/"xiaomi") fills baseUrl/model/apiKeyRef unless the
 * user set an explicit model (user model wins over the preset default).
 */
export function mergeVisionConfig(cordisConfig, fileConfig) {
  const base = Object.assign({}, VISION_DEFAULTS, cordisConfig || {})
  const parsed = fileConfig !== null && typeof fileConfig === 'object' ? fileConfig : {}
  let result = Object.assign({}, base, parsed)
  const backendName = typeof parsed.backend === 'string' && parsed.backend !== '' ? parsed.backend
    : (typeof result.backend === 'string' && result.backend !== '' ? result.backend : '')
  if (backendName !== '' && backendName !== 'custom' && Object.prototype.hasOwnProperty.call(VISION_BACKENDS, backendName)) {
    const explicitModel = (typeof parsed.model === 'string' && parsed.model !== '') ? parsed.model
      : (cordisConfig !== null && typeof cordisConfig === 'object' && typeof cordisConfig.model === 'string' && cordisConfig.model !== '' ? cordisConfig.model : undefined)
    result = Object.assign(result, VISION_BACKENDS[backendName])
    if (explicitModel !== undefined) result.model = explicitModel
  }
  return result
}

/** Read the workspace JSON config file (session cwd first, then process.cwd()). */
export async function readVisionConfigFile(cwd, configFile) {
  const name = typeof configFile === 'string' && configFile.trim() !== '' ? configFile.trim() : 'dsh-vision-config.json'
  const candidates = []
  if (cwd !== undefined) candidates.push(pathResolve(cwd, name))
  candidates.push(pathResolve(process.cwd(), name))
  for (const path of candidates) {
    try {
      const text = await readFile(path, 'utf8')
      return JSON.parse(text)
    } catch (err) {
      // try next candidate
    }
  }
  return null
}
