# Changelog

All notable changes to **dsh-visibridge** are documented in this file.

The plugin started as a session-scoped dynamic Cordis plugin (`vision-3`, v1–v10) and was later migrated to a **host-level profile bundle** that survives dsh restarts. Versioning below reflects the package's own history, with the dynamic-plugin iterations summarized under **1.0.0** as the foundation.

---

## 1.1.0 — 2026-08-18

**合规与安全整改**（基于代码审查：配置规范、死代码清理、端点校验、可测试性、发布规范）。

### Added

- **官方 Config schema**（`export const Config`，Schemastery）：插件现在符合 DSH 配置规范——可在 `cordis.yml` / `cordis.patch.yml` 插件行配置（`--dump-config` 可见），作为部署级默认；工作区 `dsh-vision-config.json` 仍可运行时覆盖（优先级：内置默认 → cordis.yml → 工作区 JSON）
- **baseUrl 端点校验**（`resolveBaseUrl`）：默认拒绝内网/保留地址（RFC1919、link-local、CGNAT、组播、`.local`），放行 localhost、小米 MiMo 与公网主机；新增 `allowPrivateHosts` 配置项显式放开
- **`configFile` 配置项**：自定义工作区覆盖配置文件的名字（cordis.yml 中设置）
- **单元测试**：`test/index.test.js`（node:test，23 例）覆盖 base64、容错 JSON 提取、证据归一化、端点校验、配置合并；`npm test` 运行
- **发布规范补全**：`LICENSE`（MIT）、`.gitignore`、`engines`（node ≥ 22.19）、`files` 白名单、`keywords`、`repository`、`CHANGELOG` 维护

### Changed

- **纯函数提取到 `lib/pure.js`**（零运行时依赖，可独立单测）；`lib/index.js` 仅保留插件装配与工具执行
- **删除 `ctx.on('dispose')` 死代码**：Cordis 核心无 `dispose` 事件（events.ts 仅 8 个 `internal/*` 事件）；且 `tools.register` 返回的即为 effect disposer，插件卸载时自动清理——无需手动补清理
- 配置合并逻辑集中到 `mergeVisionConfig`（含 backend 预设、显式 model 覆盖的语义不变）
- README（中/英）新增安全说明与配置优先级章节；安装补充 `dsh plugin add` 官方路径

### Fixed

- 修复了后端预设与显式 model 优先级的一个边界：cordis.yml 中显式 `model` 现在与工作区 JSON 的 `model` 同样生效（此前仅 JSON 生效）

### Tested

- `node --test`：23/23 通过
- `node --check`：lib/index.js、lib/pure.js 语法通过
- 行为回归：`mergeVisionConfig` 对 ollama/xiaomi/custom 三种后端、显式/自动模型、各层覆盖的语义与原实现一致（单测覆盖）

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
