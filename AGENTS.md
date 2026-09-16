# AGENTS.md — my-own-vision-mcp

> 本文件供 AI agent（opencode / openclaw / Claude Code 等）在本项目工作时遵循。
> 包含构建命令、架构、编码规范、日志规范、工具开发指南。

---

## 构建与测试

```bash
npm install          # 安装依赖
npm run build        # 编译 TypeScript → dist/（上线前必须执行）
npm run dev          # tsx 即时运行源码（开发调试，免编译）
npm start            # 运行编译产物 node dist/index.js
```

验证启动无报错：
```bash
node dist/index.js   # 应输出 config loaded / sharp 状态 / server started，Ctrl+C 退出
```

测试（手写，无框架）：
```bash
npx tsx test/image-loader-test.ts
npx tsx test/retry-test.ts
npx tsx test/analyze-screenshot-test.ts
npx tsx test/json-utils-test.ts
```

**改完代码后必须 `npm run build` 并验证启动无报错。**

---

## 架构

```
src/index.ts          入口：加载配置 → 创建 McpServer → 注册工具 → 注册 prompts → stdio 传输 → 启动 → 监听 config 文件变更热重载
src/config.ts         配置加载：项目 config.json ⊕ 用户 ~/.config/.../...json ⊕ 环境变量，deepMerge 合并。导出 resolveProviderImageDim：provider.max_image_dim ?? global.max_image_dim（2 层）
src/tools.ts          MCP 工具注册：analyze_image / extract_text / extract_structured / ping。接收 getConfig() 函数，每次调用获取最新配置。含 provider fallback 链 + 健康追踪
src/prompts.ts        MCP prompt 注册：ocr / describe / compare（用户手动 /命令，注入指令引导 AI 调用对应工具）
src/llm-client.ts     LLM HTTP 客户端：OpenAI 兼容 chat/completions，含超时/重试/jsonMode 降级
src/image-loader.ts   图片加载：file/URL/base64/data-URI → buffer → sharp 预处理 → base64 + 尺寸元数据（origWidth/scaledWidth 供 bbox 换算）
src/json-utils.ts     JSON 容错解析：6 种策略（直接解析/提取大括号/去 markdown/单引号/尾逗号/组合）
src/logger.ts         结构化日志器：时间戳 + 级别 + 类别 + reqId + 文件落盘（MY_OWN_VISION_MCP_CLIENT）+ 自动滚动
```

数据流：
```
客户端调用工具 → tools.ts handler → image-loader.ts 加载图片 → llm-client.ts 调 API → 返回结果
用户调用 prompt → prompts.ts handler → 返回 { messages } 注入对话 → AI 按指令调用工具
```

MCP 三种能力：tools（AI 自主调用，4 个）、prompts（用户手动 /命令，3 个）、resources（未用）。
首次 `server.prompt()` 调用时 SDK 自动注册 `prompts` capability，无需改 `McpServer` 构造。

### Config 热重载

`index.ts` 用 `fs.watchFile`（轮询模式，2s 间隔）监听项目 config.json 和用户 config 文件。
文件变更时 300ms 防抖后调用 `loadConfig()` 重新加载，更新 `getConfig()` 返回值。
工具 handler 每次调用时通过 `getConfig()` 获取最新配置，无需重启 MCP 进程。
工具描述中的 provider 列表在注册时固定（MCP 协议限制），`ping` 工具始终返回最新配置。

---

## 关键约束

1. **stdout 是 MCP 协议通道，绝对不能往 stdout 写任何非 JSON-RPC 内容。所有日志必须用 `console.error`（stderr）。**
2. **`safeJsonParse` 返回类型是 `Record<string, unknown> | unknown[] | null`——接受数组。不要加回 `!Array.isArray(obj)` 检查。**
3. **源码里 import 路径必须带 `.js` 后缀**（如 `import { x } from "./config.js"`），这是 ESM 规范要求，tsc 会正确解析到 `.ts` 源文件。
4. **`sharp` 是可选依赖**，代码里必须用 `getSharp()` 检测可用性，不可用时降级而非崩溃。
5. **不引入新依赖**除非确实必要。当前仅依赖 `@modelcontextprotocol/sdk` 和 `zod`。
6. **不加注释**除非用户明确要求。
7. **配置三层覆盖**：项目 config.json → 用户 ~/.config/.../...json → 环境变量。不要在代码里硬编码 API key 或 URL。

---

## 日志规范

### 为什么需要规范

上线后多个宿主软件（openclaw、opencode 等）可能同时各自拉起一个 MCP 子进程。
虽然是独立进程，但单个进程内多个工具调用可能并发（如 agent 连续多次调用 `analyze_image`）。
排查问题时需要区分是哪次调用、哪个工具、耗时多久、为什么失败。

### 规范

1. **所有日志走 `console.error`（stderr），禁止 `console.log`（stdout）。**
   stdout 是 JSON-RPC 协议通道，写入非协议内容会导致客户端解析失败。

2. **统一前缀 `[my-own-vision-mcp]`。**

3. **结构化格式**：`[my-own-vision-mcp] <level> <category> <message> <key=value ...>`
   - level: `INFO` / `WARN` / `ERROR` / `DEBUG`
   - category: `config` / `tool` / `llm` / `image` / `json` / `server`
   - key=value: 附加上下文字段

   示例：
   ```
   [my-own-vision-mcp] 2026-07-25T02:20:04.353Z INFO config loaded project=...config.json user=...my-own-vision-mcp.json
   [my-own-vision-mcp] 2026-07-25T02:21:10.123Z INFO tool call start call=analyze_image reqId=0001 image=file:/path/to/img.jpg
   [my-own-vision-mcp] 2026-07-25T02:21:11.789Z INFO tool call done call=analyze_image reqId=0001 duration=666ms
   [my-own-vision-mcp] 2026-07-25T02:21:12.345Z WARN llm HTTP error, retrying status=429 attempt=1/3 delay=2.0s
   [my-own-vision-mcp] 2026-07-25T02:21:15.678Z ERROR tool call failed call=extract_structured reqId=0003 error="JSON parse failed"
   ```

4. **每次工具调用记录**：
   - 调用开始：tool name + reqId + 参数摘要（脱敏）
   - 调用结束：reqId + duration + success/fail
   - 如果有重试：记录每次重试的原因和延迟

5. **脱敏**：日志中不输出完整 API key、不输出完整 base64 图片数据（用 `describeImageSource()` 只输出来源类型和大小）。

6. **不输出用户图片的完整内容**，只输出来源类型（file/url/base64）和大小。

### 文件落盘

日志**始终同时写 stderr 和文件**，不依赖宿主软件捕获 stderr。
宿主软件**只需传一个环境变量** `MY_OWN_VISION_MCP_CLIENT` 告知自己的名称，其余全由 MCP 自己管。

- **日志目录**：项目内 `logs/`（gitignore 忽略）
- **客户端标识**：宿主软件通过环境变量 `MY_OWN_VISION_MCP_CLIENT` 传入名称（如 `openclaw`、`opencode`）
- **日志文件**：`logs/<client>.log`，每个客户端各自独立，互不干扰
- **自动滚动**：文件超过 `config.json` 的 `logging.max_file_size`（默认 1MB）时滚动
  - `log.9` → 删除，`log.8` → `log.9`，...，`log.1` → `log.2`，`log` → `log.1`
  - 最多保留 `logging.max_files`（默认 10）个滚动文件
- 目录不存在时自动创建
- 文件写入失败不会崩溃（静默忽略，仍写 stderr）
- 启动日志会输出 `client=... logFile=...` 确认标识和落盘路径

```
my-own-vision-mcp/
├── logs/                        ← gitignore 忽略
│   ├── openclaw.log             ← openclaw 的当前日志
│   ├── openclaw.log.1           ← 最近一次滚动
│   ├── openclaw.log.2
│   ├── ...
│   ├── openclaw.log.10          ← 最旧（超过 max_files 时自动删除）
│   ├── opencode.log             ← opencode 的当前日志
│   └── opencode.log.1
```

### 宿主软件接口（唯一要求）

宿主软件启动 MCP 子进程时，在 MCP 配置的环境变量段填一个 `MY_OWN_VISION_MCP_CLIENT` 即可。

| 环境变量 | 必填 | 说明 | 示例 |
|---------|------|------|------|
| `MY_OWN_VISION_MCP_CLIENT` | 否 | 客户端名称，用于日志文件命名 | `openclaw`、`opencode` |

- **可选**，不填则默认 `default`，日志写到 `logs/default.log`
- **在宿主的 MCP 配置文件里填**，不是 shell 环境变量
- **字段名因宿主而异**：openclaw 用 `env`，opencode 用 `environment`（两者不是同一套规范，写错会被静默忽略，日志会落到 `default.log`）
- 不存在 `"client": "openclaw"` 这样的自定义字段——宿主不认识非标准字段，不会传给子进程
- 日志自动落盘到项目内 `logs/<client>.log`，无需宿主配置日志路径

宿主软件配置示例：

openclaw（`~/.openclaw/openclaw.json`）：
```jsonc
{
  "mcp": {
    "servers": {
      "my-own-vision-mcp": {
        "command": "node",
        "args": ["dist/index.js"],
        "cwd": "/path/to/my-own-vision-mcp",
        "transport": "stdio",
        "enabled": true,
        "env": {
          "MY_OWN_VISION_MCP_CLIENT": "openclaw"
        }
      }
    }
  }
}
```

opencode（`~/.config/opencode/opencode.jsonc`）：
```jsonc
{
  "mcp": {
    "my-own-vision-mcp": {
      "type": "local",
      "command": ["node", "dist/index.js"],
      "environment": {
        "MY_OWN_VISION_MCP_CLIENT": "opencode"
      }
    }
  }
}
```

---

## 编码规范

### 语言与风格

- TypeScript，`strict: true`
- ESM（`import/export`），禁止 `require`
- 4 空格缩进（保持与现有代码一致）
- 双引号字符串
- 行尾无分号（保持与现有代码一致）
- import 排序：node 内置 → 第三方 → 本地

### 错误处理

- 工具 handler 必须用 `try/catch` 包裹，catch 里调用 `errorResponse(toolName, e)` 返回结构化错误
- 不要让异常冒泡到 MCP 框架（会导致连接断开）
- LLM 调用错误分三类：`LLMHttpError`（HTTP 状态码）、`LLMNetworkError`（网络/超时）、`LLMError`（其他）

### 工具开发

新增 MCP 工具的步骤：

1. 在 `src/tools.ts` 的 `registerTools` 函数内，用 `server.tool(name, desc, zodSchema, handler)` 注册
2. Zod schema 定义参数，每个字段加 `.describe()` 说明用途。通用参数用共享常量：`maxTokensParam`
3. handler 用 `runTool(name, startFields, fn)` 包裹，它自动处理 try/catch + errorResponse + reqId + 日志计时
4. 用 `withFallback(config, toolName, fn)` 包裹 LLM 调用，自动处理 provider 降级 + 健康追踪
5. 调用 `client.visionChat` 时透传 options：`{ maxTokens: p.max_tokens, timeout }`（需要 JSON 输出时加 `jsonMode: true`）
6. 需要结构化 JSON 输出的工具，传 `jsonMode: true`（如 `extract_structured`）
7. `safeJsonParse` 解析失败时，可追加纠正 prompt 重试一次（见 `extract_structured` 的实现）

### Prompt 开发

新增 MCP prompt 的步骤：

1. 在 `src/prompts.ts` 的 `registerPrompts` 函数内，用 `server.prompt(name, desc, zodSchema, handler)` 注册（4 参重载，与 `server.tool()` 风格一致）
2. Zod schema 定义参数，每个字段加 `.describe()` 说明用途
3. handler 返回 `{ messages: [{ role: "user", content: { type: "text", text } }] }`（注意：与 tool 的 `{ content }` 不同，prompt 返回 `messages`）
4. **薄转发**：prompt 注入一句指令让 AI 调用对应 tool（如 `ocr` → `extract_text`）
5. **富指令**：prompt 注入多步工作流，引导 AI 提取+推理+建议
6. prompt handler 是纯函数（无 I/O、不调 LLM），无需 try/catch 和 errorResponse
7. `registerPrompts(server, getConfig)` 签名与 `registerTools` 一致（接收 `GetConfig = () => AppConfig` 函数，非静态 config 对象）；在 `index.ts` 中紧跟 `registerTools` 之后调用
8. 首次注册 prompt 时 SDK 自动通告 `prompts` capability，客户端（opencode/openclaw）通过 `mcp.prompts()` 自动发现

当前已注册的 3 个 prompt：

| Prompt | 风格 | 转发目标 | 参数 |
|--------|------|----------|------|
| `ocr` | 薄转发 | `extract_text` | `image` |
| `describe` | 薄转发 | `analyze_image` | `image`, `focus?` |
| `compare` | 薄转发 | `analyze_image`（多图） | `image1`, `image2`, `focus?` |

### 工具分类体系

4 个通用工具，不假定输入类型：

- `analyze_image` — 通用描述/对比（Image Captioning / VQA）。支持单图或图数组（多图时自动切换为对比模式）
- `extract_text` — OCR 文字提取，语言自动检测
- `extract_structured` — 按 schema 抽 JSON（KIE 关键信息抽取）
- `ping` — 服务健康检查 + 配置查看

**注意**：批量分析请调用方循环 `analyze_image`（每次独立超时、独立重试），不要做单次大批量工具——MCP 请求-响应模型下长调用会超时卡死。

### 配置

- 非敏感默认值放项目 `config.json`（可进 git）
- 敏感值（api_key、url）放用户 `~/.config/my-own-vision-mcp/my-own-vision-mcp.json`（不进 git）
- 新增配置字段时，在 `config.ts` 的 `loadConfig` 里加默认值填充和校验
- `AppConfig` / `ProviderConfig` / `ProviderCapabilities` / `VisionConfig` / `LoggingConfig` 接口要同步更新
- `config.json` 的 `logging` 段控制日志滚动：`max_file_size`（默认 1MB）、`max_files`（默认 10）

### Per-Provider 启用控制（enable）

每个 provider 可设 `"enable": true/false`（默认 true）。设为 false 的 provider：
- 不会出现在工具描述的 provider 列表中
- 不会被 `ping` 工具列出
- 调用时 `getProvider()` 抛错 "provider is disabled"
- 适合保留配置但不启用（如临时禁用某个模型、保留模板待填）

### Per-Provider 能力配置（capabilities）

每个 provider 可在 `capabilities` 字段下声明其视觉能力，代码据此差异化预处理图片：

```jsonc
"capabilities": {
  "max_image_dim": 2048,          // 模型能接受的最大图片尺寸（超过则降采样到此）
  "jpeg_quality": 90,             // 该模型专用的 JPEG 质量
  "best_for": ["ocr", "multilingual", "document"],  // 模型强项标签
  "supports_json_mode": true,     // 是否支持 response_format json_object
  "supports_multi_image": true,   // 是否支持多图同请求
  "rate_limit_tier": "none"       // "none"|"low"|"high" 速率限制等级
}
```

图片尺寸解析（`resolveProviderImageDim`）：
- `provider.capabilities.max_image_dim`（优先）→ `config.vision.max_image_dim`（全局默认）

**核心原则**：分辨率完全由 provider 能力驱动，无 detail 参数、无 tool 覆盖、无 detail_presets。

### LLM 客户端

- `visionChat(prompt, base64, mimeType, options)` — 单图
- `visionChatMultiImage(prompt, images, options)` — 多图
- `options`: `{ jsonMode?: boolean; maxTokens?: number; timeout?: number }`
- `jsonMode: true` 时如果 API 返回 400 含 `response_format`，自动降级重试（`llm-client.ts` 已实现）

---

## 部署

详见 `README.md`。要点：

- **Windows opencode**：配置 `opencode.jsonc` 的 `mcp` 段，`command` 为数组 `["node", "dist/index.js"]`
- **WSL openclaw**：配置 `openclaw.json` 的 `mcp.servers` 段，`command` 为字符串 `"node"`，`args` 为数组 `["dist/index.js"]`，`transport: "stdio"`
- 改代码后：`npm run build` → 重启宿主软件

### 模型发现脚本

```bash
npx tsx scripts/discover-models.ts
```

发现 OpenRouter 新增/下线的免费 vision 模型，测试每个新模型能否正常识别图片，输出报告 + config 骨架。agent 看报告后精调 `extra_notes` 和 `capabilities`，config 热重载生效。定期运行可追踪免费模型变动。

---

## 文件清单

| 文件 | 用途 |
|------|------|
| `package.json` | 依赖清单 + 命令脚本 |
| `tsconfig.json` | TypeScript 编译配置 |
| `config.json` | 运行时配置（非敏感，进 git） |
| `src/*.ts` | 源代码 |
| `scripts/discover-models.ts` | OpenRouter 免费 vision 模型发现 + 测试脚本 |
| `dist/*.js` | 编译产物（不进 git） |
| `logs/*.log` | 日志文件（不进 git，自动滚动，默认 1MB） |
| `test/*.ts` | 测试文件 |
| `README.md` | 项目说明文档（进 git） |
| `HANDBOOK.md` | 开发流程详解 + 部署手册（不进 git，本地参考） |
| `deploy-wsl.sh` | WSL 部署脚本（不进 git，本地参考） |
| `AGENTS.md` | 本文件，agent 工作规范 |
| `LICENSE` | MIT 许可证 |
| `.gitignore` | 忽略 node_modules/ dist/ logs/ *.log |
