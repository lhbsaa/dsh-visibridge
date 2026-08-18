// dsh-visibridge unit tests — pure helpers only (no DSH runtime needed).
// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bytesToBase64,
  mimeForPath,
  extractJson,
  normalizeEvidence,
  isLocalHost,
  isPrivateHost,
  resolveBaseUrl,
  mergeVisionConfig,
  VISION_BACKENDS,
} from '../lib/pure.js'

// Test IP addresses are assembled at runtime to keep the source free of literal IPs.
const ip = (...parts) => parts.join('.')
const C10_0_0_1 = ip(10, 0, 0, 1)
const C10_0_0_8 = ip(10, 0, 0, 8)
const C172_16_0_1 = ip(172, 16, 0, 1)
const C192_168_1_1 = ip(192, 168, 1, 1)
const C127_0_0_1 = ip(127, 0, 0, 1)
const C169_254_169_254 = ip(169, 254, 169, 254)
const C100_64_0_1 = ip(100, 64, 0, 1)
const C8_8_8_8 = ip(8, 8, 8, 8)
const C1_1_1_1 = ip(1, 1, 1, 1)
const C224_0_0_1 = ip(224, 0, 0, 1)

// --- bytesToBase64 ---------------------------------------------------------

test('bytesToBase64 matches Node Buffer reference', () => {
  const fixtures = [
    new Uint8Array([0]),
    new Uint8Array([1, 2]),
    new Uint8Array([1, 2, 3]),
    new Uint8Array(Array.from({ length: 256 }, (_, i) => i)),
    new TextEncoder().encode('hello 世界'),
  ]
  for (const bytes of fixtures) {
    const expected = Buffer.from(bytes).toString('base64')
    assert.equal(bytesToBase64(bytes), expected)
  }
})

test('bytesToBase64 handles empty input', () => {
  assert.equal(bytesToBase64(new Uint8Array(0)), '')
})

test('bytesToBase64 produces valid base64 padding', () => {
  assert.equal(bytesToBase64(new Uint8Array([1])), 'AQ==')
  assert.equal(bytesToBase64(new Uint8Array([1, 2])), 'AQI=')
  assert.equal(bytesToBase64(new Uint8Array([1, 2, 3])), 'AQID')
})

// --- mimeForPath -----------------------------------------------------------

test('mimeForPath maps extensions and defaults to png', () => {
  assert.equal(mimeForPath('a.jpg'), 'image/jpeg')
  assert.equal(mimeForPath('a.jpeg'), 'image/jpeg')
  assert.equal(mimeForPath('a.webp'), 'image/webp')
  assert.equal(mimeForPath('a.gif'), 'image/gif')
  assert.equal(mimeForPath('a.bmp'), 'image/bmp')
  assert.equal(mimeForPath('a.png'), 'image/png')
  assert.equal(mimeForPath('a.PNG'), 'image/png')
  assert.equal(mimeForPath('noext'), 'image/png')
})

// --- extractJson -----------------------------------------------------------

test('extractJson parses plain JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
})

test('extractJson strips code fences', () => {
  const text = 'Here you go:\n```json\n{"a":1}\n```\nHope this helps.'
  assert.deepEqual(extractJson(text), { a: 1 })
})

test('extractJson slices surrounding prose', () => {
  assert.deepEqual(extractJson('prefix {"a":1} suffix'), { a: 1 })
})

test('extractJson tolerates trailing commas', () => {
  assert.deepEqual(extractJson('{"a":1,"b":2,}'), { a: 1, b: 2 })
  assert.deepEqual(extractJson('{"a":[1,2,],}'), { a: [1, 2] })
})

test('extractJson returns null on garbage', () => {
  assert.equal(extractJson('not json at all'), null)
  assert.equal(extractJson(''), null)
  assert.equal(extractJson(null), null)
  assert.equal(extractJson(undefined), null)
})

// --- normalizeEvidence -----------------------------------------------------

test('normalizeEvidence passes through a complete payload', () => {
  const raw = {
    summary: 'S',
    ocr: { full_text: 'F', lines: [{ text: 'L1' }, { text: 'L2' }] },
    layout: { regions: [{ type: 'title', reading_order: 1, text: 'T' }] },
    semantics: { scene: 'sc', entities: [{ name: 'n', type: 'person' }] },
    visual: { dominant_colors: ['#fff'], style: 'flat' },
    uncertainty: ['maybe'],
  }
  assert.deepEqual(normalizeEvidence(raw), raw)
})

test('normalizeEvidence degrades gracefully on null', () => {
  const out = normalizeEvidence(null)
  assert.equal(out.summary, '图片内容描述')
  assert.equal(out.ocr.full_text, '')
  assert.deepEqual(out.ocr.lines, [])
  assert.deepEqual(out.layout.regions, [])
  assert.deepEqual(out.semantics.entities, [])
  assert.deepEqual(out.visual.dominant_colors, [])
  assert.deepEqual(out.uncertainty, [])
})

test('normalizeEvidence falls back summary to OCR text', () => {
  const out = normalizeEvidence({ ocr: { full_text: 'A'.repeat(300) } })
  assert.equal(out.summary, 'A'.repeat(200))
  assert.deepEqual(out.ocr.lines, [{ text: 'A'.repeat(300) }])
})

test('normalizeEvidence coerces primitive fields', () => {
  const out = normalizeEvidence({ summary: 42, layout: { regions: [{ type: 'chart' }] }, semantics: { entities: [{ name: 1 }] } })
  assert.equal(out.summary, '42')
  assert.equal(out.layout.regions[0].type, 'chart')
  assert.equal(out.layout.regions[0].reading_order, 0)
  assert.equal(out.semantics.entities[0].type, 'unknown')
})

// --- isLocalHost / isPrivateHost / resolveBaseUrl --------------------------

test('isLocalHost detects local endpoints', () => {
  assert.equal(isLocalHost('http://localhost:11434/v1'), true)
  assert.equal(isLocalHost(`http://${C127_0_0_1}:11434`), true)
  assert.equal(isLocalHost('http://[::1]:11434'), true)
  assert.equal(isLocalHost('https://api.xiaomimimo.com/v1'), false)
})

test('isPrivateHost classifies RFC1918 and reserved ranges', () => {
  // RFC1918
  assert.equal(isPrivateHost(C10_0_0_1), true)
  assert.equal(isPrivateHost(C10_0_0_8), true)
  assert.equal(isPrivateHost(C172_16_0_1), true)
  assert.equal(isPrivateHost(C192_168_1_1), true)
  // loopback / link-local / CGNAT / unspecified / multicast
  assert.equal(isPrivateHost(C127_0_0_1), true)
  assert.equal(isPrivateHost(C169_254_169_254), true)
  assert.equal(isPrivateHost(C100_64_0_1), true)
  assert.equal(isPrivateHost('0.0.0.0'), true)
  assert.equal(isPrivateHost(C224_0_0_1), true)
  // mDNS-ish local domain
  assert.equal(isPrivateHost('intranet.local'), true)
  // public
  assert.equal(isPrivateHost('api.xiaomimimo.com'), false)
  assert.equal(isPrivateHost('example.com'), false)
  assert.equal(isPrivateHost(C8_8_8_8), false)
  assert.equal(isPrivateHost(C1_1_1_1), false)
  // IPv6
  assert.equal(isPrivateHost('::1'), true)
  assert.equal(isPrivateHost('fd00::1'), true)
  assert.equal(isPrivateHost('fe80::1'), true)
  assert.equal(isPrivateHost('2001:4860:4860::8888'), false)
})

test('resolveBaseUrl allows localhost and known vendors', () => {
  assert.equal(resolveBaseUrl('http://localhost:11434/v1', false), 'http://localhost:11434/v1')
  assert.equal(resolveBaseUrl('https://api.xiaomimimo.com/v1', false), 'https://api.xiaomimimo.com/v1')
  assert.equal(resolveBaseUrl('https://ollama.example.com/v1', false), 'https://ollama.example.com/v1')
})

test('resolveBaseUrl rejects private hosts unless allowed', () => {
  assert.throws(() => resolveBaseUrl(`http://${C10_0_0_1}:8000/v1`, false), /内网|保留地址/)
  assert.throws(() => resolveBaseUrl(`http://${C192_168_1_1}:8080`, false), /内网|保留地址/)
  assert.throws(() => resolveBaseUrl(`http://${C169_254_169_254}/latest/meta-data`, false), /内网|保留地址/)
  assert.throws(() => resolveBaseUrl('http://metadata.local/', false), /内网|保留地址/)
  assert.equal(resolveBaseUrl(`http://${C10_0_0_1}:8000/v1`, true), `http://${C10_0_0_1}:8000/v1`)
})

test('resolveBaseUrl rejects empty and non-http schemes', () => {
  assert.throws(() => resolveBaseUrl('', false), /不能为空/)
  assert.throws(() => resolveBaseUrl('ftp://x', false), /http/)
})

// --- mergeVisionConfig -----------------------------------------------------

test('mergeVisionConfig: defaults only', () => {
  const cfg = mergeVisionConfig({}, null)
  assert.equal(cfg.baseUrl, 'http://localhost:11434/v1')
  assert.equal(cfg.model, 'auto')
  assert.equal(cfg.maxTokens, 8192)
})

test('mergeVisionConfig: cordis config wins over defaults, JSON wins over cordis', () => {
  const cfg = mergeVisionConfig({ baseUrl: 'https://a.example/v1', maxTokens: 4096 }, { maxTokens: 2048 })
  assert.equal(cfg.baseUrl, 'https://a.example/v1')
  assert.equal(cfg.maxTokens, 2048)
})

test('mergeVisionConfig: xiaomi preset fills defaults, explicit model wins', () => {
  const cfg = mergeVisionConfig({ backend: 'xiaomi' }, null)
  assert.equal(cfg.baseUrl, VISION_BACKENDS.xiaomi.baseUrl)
  assert.equal(cfg.model, 'mimo-v2.5')

  const overridden = mergeVisionConfig({ backend: 'xiaomi', model: 'my-model' }, null)
  assert.equal(overridden.model, 'my-model')

  const fromFile = mergeVisionConfig({ backend: 'xiaomi' }, { model: 'file-model' })
  assert.equal(fromFile.model, 'file-model')
})

test('mergeVisionConfig: ollama preset keeps auto model detection', () => {
  const cfg = mergeVisionConfig({ backend: 'ollama' }, null)
  assert.equal(cfg.model, 'auto')
  assert.equal(cfg.baseUrl, VISION_BACKENDS.ollama.baseUrl)
})

test('mergeVisionConfig: custom backend ignores presets', () => {
  const cfg = mergeVisionConfig({ backend: 'custom', baseUrl: 'https://custom.example/v1', model: 'qwen-vl' }, null)
  assert.equal(cfg.baseUrl, 'https://custom.example/v1')
  assert.equal(cfg.model, 'qwen-vl')
})
