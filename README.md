# vision-bridge

**DeepSeek Harness（dsh）宿主级视觉插件** —— 为纯文本模型（DeepSeek、GLM 等）补全图像识别能力。

`analyze_image` 工具把图片发送给配置的视觉模型（本机 Ollama / 小米 MiMo 云端 / 任意 OpenAI 兼容端点），返回**结构化 JSON 证据**（OCR 全文、版面、场景、实体、不确定项），纯文本模型基于证据回答，不再"凭空猜测"。

- 宿主级 bundle 插件：**dsh 重启后自动加载**，任何会话、任何 preset 都可用
- 无需代理进程、无需 hook、无需修改 harness 核心配置
- 图片默认在本机处理（Ollama 后端零上传）

---

## 功能特性

| 能力 | 说明 |
|------|------|
| 图片识别 | 本地文件路径 / http(s) URL 均可 |
| 结构化证据 | `summary`（总结）、`ocr`（全文+逐行）、`layout`（版面区块）、`semantics`（场景+实体）、`visual`（配色+风格）、`uncertainty`（不确定项） |
| 双后端预设 | `"ollama"`（本地）/ `"xiaomi"`（小米 MiMo 云端）一行切换 |
| 任意 OpenAI 兼容端点 | `"custom"`：自设 baseUrl/model/apiKey，支持 qwen-vl、GLM、SiliconFlow、OpenRouter 等 |
| 小米 MiMo 适配 | 自动识别 `xiaomimimo.com` 端点：`api-key` 认证头 + `max_completion_tokens` 字段 |
| Ollama 结构化输出 | 本地后端自动启用 `response_format: json_schema` 强制合法 JSON（小模型结构不稳时尤其关键），模型不支持时自动降级 |
| 模型常驻 | 本地 Ollama 自动 `keep_alive: 30m`，避免反复冷加载 |
| 密钥安全 | 错误消息中的 API Key 自动脱敏（`[REDACTED]`） |
| 传输 | 原生 `fetch` + `node:fs`（宿主完整 Node 环境，无额外进程开销） |

---

## 架构

```
DeepSeek V4（纯文本，看不到图）
   │ 调用 analyze_image 工具
   ▼
vision-bridge（宿主插件，dsh 启动即加载）
   ├─ 读取 dsh-vision-config.json（backend/model/密钥引用）
   ├─ 本地图片 → base64 data URL；URL 直传
   ├─ POST /v1/chat/completions → 视觉模型
   │    ├─ Ollama：json_schema 强制输出 + keep_alive 常驻
   │    └─ 小米 MiMo：api-key 头 + max_completion_tokens
   └─ 容错 JSON 提取 + 归一化 → 结构化证据 → 返回给 V4
```

插件以 **profile bundle** 方式挂载（与 ModLens、dshmarket 同款机制）：

```
dsh 启动 → 读 profile 的 dsh.profile.bundles → 加载 vision-bridge 包的 dsh.bundle.patch
        → 插件行插入 host composition → analyze_image 全局注册
```

---

## 环境要求

- **DeepSeek Harness**（web profile）
- **Node.js ≥ 22**（原生 `fetch`、`AbortSignal.timeout`）
- **视觉模型后端**（任选其一）：
  - 本机 [Ollama](https://ollama.com) + 视觉模型（推荐 `minicpm-v4.5`）
  - 小米 MiMo API Key（[小米开放平台](https://platform.xiaomimimo.com)）

---

## 安装步骤

> 以下以 Windows 为例（dsh profile 为 `web`，Harness home 为 `~/.dsh`）。

### 1. 放置插件包

将整个 `vision-bridge` 目录复制到 profile 的 node_modules：

```powershell
# 源目录（本副本所在位置）
$src = 'G:\gitub-peo\vision-bridge'

# 目标 1：profile node_modules
Copy-Item $src 'C:\Users\Administrator\.dsh\profiles\web\node_modules\vision-bridge' -Recurse -Force

# 目标 2：全局 npm node_modules（确保 dsh 的 loader 无论从哪个上下文都能解析）
Copy-Item $src 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\vision-bridge' -Recurse -Force
```

> ⚠️ 两个位置都要放：dsh 的插件 loader 从**安装目录**解析包名，而 profile 的 `resolveBundleDir` 从 profile 解析——双保险最稳。

### 2. 注册 bundle

编辑 profile 清单 `~\.dsh\profiles\web\package.json`：

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

（在 `bundles` 数组末尾追加 `"vision-bridge"`。）

### 3. 验证组合配置（可选）

```powershell
npx -y @deepseek-ai/dsh --profile web --dump-config | Select-String 'vision-bridge'
```

应能看到 `- id: vision-bridge` / `name: vision-bridge`。

### 4. 重启 dsh

**彻底重启**（关闭 → 确认 node 进程退出 → 重新启动）。重启后 `analyze_image` 自动注册，无需任何手动激活。

### 5. 配置视觉后端

在工作区根目录创建 `dsh-vision-config.json`：

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

`backend` 决定默认三件套：

| backend | baseUrl | model | apiKeyRef |
|---------|---------|-------|-----------|
| `ollama` | `http://localhost:11434/v1` | `auto`（自动挑视觉模型，可显式覆盖） | `VISION_API_KEY` |
| `xiaomi` | `https://api.xiaomimimo.com/v1` | `mimo-v2.5` | `XIAOMI_MIMO_API_KEY` |
| `custom` / 省略 | 完全使用显式字段 | 显式 | 显式 |

> 显式 `model` 会覆盖预设默认（如在 `ollama` 下指定 `"minicpm-v4.5"`）。

### 6. 配置云端 API Key（小米等）

凭据文件 `~\.dsh\.credentials.yaml`（YAML，0600）：

```yaml
XIAOMI_MIMO_API_KEY: sk-xxxxxxxx
```

或设置同名环境变量（凭据服务优先读环境）。凭据文件有文件监控，**热加载无需重启**。

---

## 使用

1. **放图**：把图片放进会话工作区（或提供 http(s) 图片链接）
2. **说一句**：`看下这张图` / `分析 xxx.png` / `识别 https://example.com/pic.png`
3. DeepSeek V4 调用 `analyze_image` → 基于结构化证据回答

**切换后端**（无需重启，改配置文件即生效）：

```json
{ "backend": "xiaomi" }   // 小米 MiMo 云端（图片上传云端，注意隐私）
{ "backend": "ollama" }   // 本机 Ollama（图片不出本机）
```

也可以直接对 AI 说「切换到 Ollama / 小米」，由 AI 修改配置文件。

---

## 配置字段速查

| 字段 | 默认 | 说明 |
|------|------|------|
| `backend` | — | `"ollama"` / `"xiaomi"` / `"custom"`（省略走显式字段） |
| `baseUrl` | `http://localhost:11434/v1` | OpenAI 兼容端点 |
| `model` | `auto` | 显式指定模型名（`auto` 仅 Ollama 有效） |
| `apiKeyRef` | `VISION_API_KEY` | 凭据引用名（`~/.dsh/.credentials.yaml` 或环境变量） |
| `timeoutMs` | `300000` | 请求超时（毫秒） |
| `maxTokens` | `8192` | 视觉模型输出上限 |
| `maxBytes` | `8388608` | 图片字节上限（8MB） |
| `authStyle` | 自动 | `"bearer"` / `"api-key"`（默认按端点自动识别） |
| `keepAlive` | 本地 `30m` | 本地 Ollama 常驻；`false` 关闭 |
| `structuredOutput` | 本地开启 | `false` 关闭 json_schema 强制 |

---

## 视觉模型建议（Ollama 本地）

| 模型 | 大小 | 定位 |
|------|------|------|
| **minicpm-v4.5** | 8B（~6GB） | **推荐**：本地最强 OCR/文档识别（`ollama pull minicpm-v4.5`） |
| qwen3-vl:4b | 4B | 轻量均衡 |
| minicpm-v4.6 | 1.3B | 极轻量、低配机器 |
| glm-ocr | 1.1B | 专注 OCR |

---

## 常见问题

| 现象 | 处理 |
|------|------|
| 重启后没有 `analyze_image` 工具 | 确认两处 node_modules 都有包 + `package.json` bundles 含 `vision-bridge` + 彻底重启（杀净 node 进程） |
| `[vision-bridge] tools service not available` | 插件代码须用 `inject: ['tools', ...]`（本项目已内置，勿改动） |
| 识别返回"降级提取" | 视觉模型未按 JSON 输出；Ollama 后端已用 json_schema 强制，若仍出现请确认模型支持 |
| 小米 API 报错 | 确认 `XIAOMI_MIMO_API_KEY` 已配置（credentials.yaml 或环境变量） |
| 图片超限 | `maxBytes` 调大或先压缩图片 |

---

## 卸载 / 回滚

1. `~\.dsh\profiles\web\package.json`：从 `bundles` 数组移除 `"vision-bridge"`
2. 删除两处 `node_modules\vision-bridge` 目录
3. 重启 dsh

---

## 兼容性说明

- 传输层使用原生 `fetch`（Node ≥ 22）
- 运行时依赖 `@deepseek-ai/dsh-tools`（由 dsh 安装提供，自动解析）
- 不依赖 agent 级服务（fs/subprocess/sandboxPolicy），宿主顶层即可运行

## License

MIT
