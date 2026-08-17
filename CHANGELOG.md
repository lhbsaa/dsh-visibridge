# Changelog

All notable changes to **dsh-visibridge** are documented in this file.

The plugin started as a session-scoped dynamic Cordis plugin (`vision-3`, v1–v10) and was later migrated to a **host-level profile bundle** that survives dsh restarts. Versioning below reflects the package's own history, with the dynamic-plugin iterations summarized under **1.0.0** as the foundation.

---

## 1.0.0 — 2026-08-17

**Host-level release.** Migrated from a session dynamic plugin to a profile bundle plugin; `analyze_image` is registered globally and auto-loaded on every dsh restart.

### Added (host migration)

- Profile bundle packaging (`dsh.bundle.patch` + `cordis.patch.yml` insert row), same mechanism as ModLens / dshmarket
- Installable from either the profile `node_modules` or the global npm `node_modules` (loader double-resolution)
- Plugin now uses standard host-plugin conventions:
  - `inject: ['tools', 'systemPrompt', 'credentials']` (was `ctx.get`, which cannot reach host-level tools)
  - Native `fetch` + `node:fs` transport (was agent-scoped `subprocess` + `curl` — those services are not reachable from the host top level)
- Credential resolution: `ctx.credentials` first, environment variable fallback
- Config discovery: session cwd → `process.cwd()` for `dsh-vision-config.json`

### Foundation (dynamic-plugin era, v1 → v10)

- **v1** — initial `analyze_image` tool; image path/URL input; configurable OpenAI-compatible endpoint; Ollama + Xiaomi MiMo support
- **v2** — session-cwd resolution for relative image paths; session-aware sandbox policy
- **v3** — hand-written base64 encoder (harness `btoa` is UTF-8-text semantics and corrupts binary data)
- **v4** — `max_tokens` raised to 8192; reasoning-fallback when content is empty (thinking models)
- **v5** — `subprocess.spawn` direct-curl transport (removed pwsh overhead); TTL caches for model detection & config; Ollama `keep_alive`; one transport retry; 8 MB image cap; multi-backend auth (`api-key` for Xiaomi, `max_completion_tokens` adaptation)
- **v6** — `backend` preset field (`ollama` / `xiaomi` / `custom`); explicit `model` overrides presets; config cache removed so backend switches apply immediately
- **v7** — structured evidence output contract (summary / ocr / layout / semantics / visual / uncertainty); tolerant JSON extraction (code block + bracket slicing); normalization to guarantee schema compliance; API-key redaction in error messages
- **v8** — explicit model override inside presets; minicpm added to auto-detection ranking
- **v9** — trailing-comma tolerant JSON extraction (fixes minicpm-v4.5 output)
- **v10** — `response_format: json_schema` enforced structured output on Ollama (with automatic degrade-and-retry when unsupported); `structuredOutput` config flag

### Tested

- Local: Ollama `minicpm-v4.5` (Arduino IDE screenshot full OCR), `qwen3-vl:4b`, `minicpm-v4.6`
- Cloud: Xiaomi MiMo `mimo-v2.5` (api-key auth, `max_completion_tokens`)
- Host loading verified via temporary dsh instance and `--dump-config`
