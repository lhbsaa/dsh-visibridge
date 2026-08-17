# vision-bridge

**Host-level vision plugin for DeepSeek Harness (dsh)** — adds image recognition to text-only models (DeepSeek, GLM, etc.).

The `analyze_image` tool sends an image to a configured vision model (local Ollama / Xiaomi MiMo cloud / any OpenAI-compatible endpoint) and returns **structured JSON evidence** (full OCR text, layout, scene, entities, uncertainty), so a text-only model answers from real evidence instead of guessing.

- Host-level bundle plugin: **auto-loaded on every dsh restart**, available in any session and any preset
- No proxy process, no hooks, no changes to harness core config
- Images stay local by default (zero upload with the Ollama backend)

---

## Features

| Capability | Description |
|------------|-------------|
| Image input | Local file path or http(s) URL |
| Structured evidence | `summary`, `ocr` (full_text + lines), `layout` (regions), `semantics` (scene + entities), `visual` (colors + style), `uncertainty` |
| Backend presets | One-line switch: `"ollama"` (local) / `"xiaomi"` (Xiaomi MiMo cloud) |
| Any OpenAI-compatible endpoint | `"custom"`: own baseUrl/model/apiKey (qwen-vl, GLM, SiliconFlow, OpenRouter, vLLM, …) |
| Xiaomi MiMo adaptation | Auto-detects `xiaomimimo.com`: `api-key` auth header + `max_completion_tokens` field |
| Ollama structured output | Local backend sends `response_format: json_schema` to force valid JSON (critical for small models); auto-degrades when unsupported |
| Model keep-alive | Local Ollama gets `keep_alive: 30m` to avoid repeated cold loads |
| Key safety | API keys are redacted (`[REDACTED]`) in any error message |
| Transport | Native `fetch` + `node:fs` (full Node runtime; no extra process overhead) |

---

## Architecture

```
DeepSeek V4 (text-only, cannot see images)
   │ calls analyze_image tool
   ▼
vision-bridge (host plugin, loaded at dsh startup)
   ├─ reads dsh-vision-config.json (backend/model/key ref)
   ├─ local image → base64 data URL; URL passed through
   ├─ POST /v1/chat/completions → vision model
   │    ├─ Ollama: json_schema enforced output + keep_alive
   │    └─ Xiaomi MiMo: api-key header + max_completion_tokens
   └─ tolerant JSON extraction + normalization → structured evidence → back to V4
```

Mounted as a **profile bundle** (same mechanism as ModLens / dshmarket):

```
dsh starts → reads dsh.profile.bundles → loads vision-bridge's dsh.bundle.patch
          → plugin row inserted into host composition → analyze_image registered globally
```

---

## Requirements

- **DeepSeek Harness** (web profile)
- **Node.js ≥ 22** (native `fetch`, `AbortSignal.timeout`)
- A vision backend (choose one):
  - Local [Ollama](https://ollama.com) with a vision model (recommended: `minicpm-v4.5`)
  - Xiaomi MiMo API key ([Xiaomi Open Platform](https://platform.xiaomimimo.com))

---

## Installation

> Windows examples below (dsh profile `web`, Harness home `~/.dsh`).

### 1. Place the plugin package

Copy the whole `vision-bridge` directory into the profile's node_modules:

```powershell
$src = 'G:\gitub-peo\vision-bridge'

# Target 1: profile node_modules
Copy-Item $src 'C:\Users\Administrator\.dsh\profiles\web\node_modules\vision-bridge' -Recurse -Force

# Target 2: global npm node_modules (so dsh's loader resolves from either context)
Copy-Item $src 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\vision-bridge' -Recurse -Force
```

> ⚠️ Both locations matter: dsh's plugin loader resolves bare package names from the **installation directory**, while `resolveBundleDir` resolves from the profile. Two copies are the safest.

### 2. Register the bundle

Edit the profile manifest `~\.dsh\profiles\web\package.json`:

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dshmarket": "^1.5.0",
    "vision-bridge": "link:./node_modules/vision-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dshmarket",
        "vision-bridge"
      ]
    }
  }
}
```

(Append `"vision-bridge"` to the `bundles` array.)

### 3. Verify the composed config (optional)

```powershell
npx -y @deepseek-ai/dsh --profile web --dump-config | Select-String 'vision-bridge'
```

You should see `- id: vision-bridge` / `name: vision-bridge`.

### 4. Restart dsh

**Fully restart** (close → confirm node processes are gone → start again). After restart `analyze_image` is registered automatically — no manual activation needed.

### 5. Configure the vision backend

Create `dsh-vision-config.json` in your workspace root:

```json
{
  "backend": "ollama",
  "model": "minicpm-v4.5",
  "baseUrl": "http://localhost:11434/v1",
  "apiKeyRef": "VISION_API_KEY",
  "timeoutMs": 300000,
  "maxTokens": 8192,
  "maxBytes": 8388608
}
```

`backend` decides the defaults:

| backend | baseUrl | model | apiKeyRef |
|---------|---------|-------|-----------|
| `ollama` | `http://localhost:11434/v1` | `auto` (pick a vision model; explicit value overrides) | `VISION_API_KEY` |
| `xiaomi` | `https://api.xiaomimimo.com/v1` | `mimo-v2.5` | `XIAOMI_MIMO_API_KEY` |
| `custom` / omitted | explicit fields only | explicit | explicit |

> An explicit `model` overrides the preset default (e.g. `"minicpm-v4.5"` under `ollama`).

### 6. Configure cloud API keys (Xiaomi etc.)

Credentials file `~\.dsh\.credentials.yaml` (YAML, 0600):

```yaml
XIAOMI_MIMO_API_KEY: sk-xxxxxxxx
```

Or set an environment variable of the same name (credentials service prefers env). The file is watched — **hot reload, no restart needed**.

---

## Usage

1. **Put the image** in the session workspace (or provide an http(s) URL)
2. **Say it**: `看下这张图` / `分析 xxx.png` / `识别 https://example.com/pic.png`
3. DeepSeek V4 calls `analyze_image` → answers from structured evidence

**Switch backend** (no restart; edit the config file):

```json
{ "backend": "xiaomi" }   // Xiaomi MiMo cloud (image leaves the machine — mind privacy)
{ "backend": "ollama" }   // local Ollama (image never leaves the machine)
```

Or just tell the AI "switch to Ollama / Xiaomi" and let it edit the config.

---

## Configuration reference

| Field | Default | Description |
|-------|---------|-------------|
| `backend` | — | `"ollama"` / `"xiaomi"` / `"custom"` (omitted = explicit fields) |
| `baseUrl` | `http://localhost:11434/v1` | OpenAI-compatible endpoint |
| `model` | `auto` | Explicit model name (`auto` works on Ollama only) |
| `apiKeyRef` | `VISION_API_KEY` | Credential reference (`~/.dsh/.credentials.yaml` or env var) |
| `timeoutMs` | `300000` | Request timeout (ms) |
| `maxTokens` | `8192` | Vision model output cap |
| `maxBytes` | `8388608` | Image byte cap (8 MB) |
| `authStyle` | auto | `"bearer"` / `"api-key"` (auto-detected per endpoint) |
| `keepAlive` | `30m` local | Ollama keep-alive; `false` disables |
| `structuredOutput` | on for local | `false` disables json_schema enforcement |

---

## Recommended local models (Ollama)

| Model | Size | Role |
|-------|------|------|
| **minicpm-v4.5** | 8B (~6 GB) | **Recommended**: strongest local OCR / document recognition (`ollama pull minicpm-v4.5`) |
| qwen3-vl:4b | 4B | Lightweight all-rounder |
| minicpm-v4.6 | 1.3B | Ultra-light, low-end machines |
| glm-ocr | 1.1B | OCR-focused |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No `analyze_image` tool after restart | Confirm both node_modules copies exist, `bundles` contains `vision-bridge`, and dsh was fully restarted (all node processes killed) |
| `[vision-bridge] tools service not available` | The plugin must use `inject: ['tools', ...]` (already built in — don't remove) |
| Result says "degraded extraction" | Vision model didn't output JSON; Ollama uses json_schema to force it — if it persists, check model support |
| Xiaomi API errors | Confirm `XIAOMI_MIMO_API_KEY` is configured (credentials.yaml or env var) |
| Image over limit | Raise `maxBytes` or compress the image first |

---

## Uninstall / rollback

1. `~\.dsh\profiles\web\package.json`: remove `"vision-bridge"` from `bundles`
2. Delete both `node_modules\vision-bridge` directories
3. Restart dsh

---

## Compatibility

- Transport uses native `fetch` (Node ≥ 22)
- Runtime dependency `@deepseek-ai/dsh-tools` (provided by the dsh install, auto-resolved)
- No dependency on agent-scoped services (fs/subprocess/sandboxPolicy); runs at host top level

## License

MIT
