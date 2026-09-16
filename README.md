# my-own-vision-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-blue.svg)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org)

A standalone [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives AI agents **vision capabilities** — image analysis, OCR, structured extraction, image comparison, and GUI screenshot-to-accessibility-tree conversion.

It calls any **OpenAI-compatible vision API** directly (Qwen-VL, GPT-4o, Claude, GLM-4V, etc.) — no Python, no extra services, just Node.js.

> **Works with:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) · [Cursor](https://cursor.com) · [Windsurf](https://windsurf.com) · [Cline](https://github.com/cline/cline) · [opencode](https://opencode.ai) · [openclaw](https://github.com/anthropics/anthropic-quickstarts) · any MCP-compatible client

---

## The idea

Most capable coding agents run on **text-only models** — fast and cheap, but blind to images. You *could* switch to a multimodal model for everything, but that's expensive: vision tokens cost 5-20x more than text tokens, and most coding tasks don't need vision at all.

**This project takes a different approach:**

```
                    ┌─────────────────────────┐
  user request ───▶ │  text-only agent model   │  ← cheap, fast, handles 95% of work
                    │  (opencode / openclaw /  │
                    │   Claude Code / Cursor)  │
                    └──────────┬──────────────┘
                               │ "I need to see this image"
                               │ calls MCP tool
                               ▼
                    ┌─────────────────────────┐
                    │  dedicated vision model   │  ← only invoked when needed
                    │  (Qwen-VL / GPT-4o /     │
                    │   GLM-4V / local vLLM)   │
                    └─────────────────────────┘
```

- **Extend capabilities** — a text-only agent gains on-demand vision: OCR, image description, screenshot-to-UI-tree, structured extraction
- **Save cost** — the expensive vision model is called *only* when an image is involved, not on every turn
- **Decouple models** — swap the agent model and the vision model independently; use a cheap local model for coding and a powerful cloud model for vision, or vice versa

---

## Why use this?

AI coding agents (Claude Code, Cursor, Windsurf, Cline, opencode, openclaw, etc.) can't see images. This MCP server bridges that gap by exposing vision tools that the agent can call autonomously:

| Scenario | Tool | Example |
|----------|------|---------|
| **Describe a photo / screenshot** | `analyze_image` | "What's in this error screenshot?" |
| **Extract text from images** (OCR) | `extract_text` | Read a scanned document, receipt, or meme |
| **Extract structured data** from an image | `extract_structured` | Pull `{name, date, total}` from an invoice |
| **Compare two images** | `compare_images` | "Did the UI change between these two screenshots?" |
| **Screenshot → UI tree** for agent interaction | `analyze_screenshot` | Convert a webpage screenshot into clickable elements with bbox coordinates |

### Key features

- **6 tools + 4 prompts** covering general vision and GUI screenshot analysis
- **Any OpenAI-compatible API** — configure your endpoint and key, done
- **Multiple input formats** — file path, base64, or URL
- **Automatic image preprocessing** — resize/compress via `sharp` (optional) to reduce API costs
- **bbox coordinate scaling** — `analyze_screenshot` maps UI element coordinates back to the original image dimensions
- **Structured logging** — stderr + auto-rotating log files, one per host client
- **Retry with backoff** — configurable retry on 429/5xx, empty-response retry, JSON-mode fallback
- **Zero Python dependency** — pure TypeScript/Node.js

---

## Quick start

```bash
git clone https://github.com/vectorequa/my-own-vision-mcp.git
cd my-own-vision-mcp
npm install
npm run build
```

### 1. Configure your API key

Create `~/.config/my-own-vision-mcp/my-own-vision-mcp.json` (on Windows: `%USERPROFILE%\.config\my-own-vision-mcp\my-own-vision-mcp.json`):

```json
{
  "llm": {
    "providers": {
      "qwen": {
        "url": "https://your-api-endpoint/v1",
        "api_key": "your-actual-api-key"
      }
    }
  }
}
```

This file is deep-merged over the project `config.json`. Only `url` and `api_key` need to be set here; model/max_tokens/timeout come from the project config.

Alternatively, set env var `MY_OWN_VISION_MCP_API_KEY`.

### 2. Register with your MCP host

**opencode** (`opencode.json` or `~/.config/opencode/opencode.json`):

```jsonc
{
  "mcp": {
    "my-own-vision-mcp": {
      "type": "local",
      "command": ["node", "dist/index.js"],
      "cwd": "/path/to/my-own-vision-mcp",
      "environment": {
        "MY_OWN_VISION_MCP_CLIENT": "opencode"
      }
    }
  }
}
```

**openclaw** (`~/.openclaw/openclaw.json`):

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

**Any other MCP-compatible client** — use stdio transport, command `node dist/index.js`, working directory set to the project root.

### 3. Verify

Ask your agent to call the `ping` tool. You should get:

```json
{
  "status": "ok",
  "provider": "qwen",
  "model": "your-model-name",
  "max_tokens": 16384,
  "timeout": 120,
  "max_retries": 3,
  "max_504_retries": 1,
  "all_providers": { "qwen": { "model": "your-model-name" } },
  "vision": {
    "max_image_dim": 1280,
    "jpeg_quality": 85,
    "detail_presets": { "low": 768, "medium": 1024, "high": 1920 }
  }
}
```

(Full response also includes `extra_notes`, `capabilities`, and per-tool vision overrides — call `ping` to see all fields.)

---

## Tools

### General image tools

| Tool | Description | Key params |
|------|-------------|------------|
| `analyze_image` | Analyze an image → text description | `image`, `prompt?` |
| `extract_text` | OCR: extract all text, preserving layout | `image` |
| `extract_structured` | Extract structured JSON guided by a schema | `image`, `schema` |
| `compare_images` | Compare two images → similarities/differences | `image1`, `image2`, `prompt?` |
| `ping` | Check server health and config | — |

### GUI screenshot tools

| Tool | Description | Key params |
|------|-------------|------------|
| `analyze_screenshot` | Extract UI accessibility tree (role/name/ref/bbox) from a screenshot | `image`, `format?` (`axtree`\|`json`), `max_elements?` |

`analyze_screenshot` returns an accessibility tree of the screenshot. `bbox` is in the **original screenshot coordinate system** — the handler scales the model's output by `origWidth/scaledWidth` so coordinates map back to the original image without caller-side conversion. Output ends with a `[meta: {...}]` line showing the scale factor.

> Use `analyze_screenshot` only for GUI screenshots. For general photos, use `analyze_image`. For custom field extraction, use `extract_structured`.

### Prompts (user-invoked workflows)

| Prompt | What it does |
|--------|-------------|
| `ocr` | Thin redirect → calls `extract_text` |
| `describe` | Thin redirect → calls `analyze_image` |
| `compare` | Thin redirect → calls `compare_images` |
| `ui-tree` | Rich workflow → calls `analyze_screenshot` + structure analysis + action suggestions |

All image inputs accept: **file path**, **base64 string**, or **URL** (http/https).

### Common parameters

All tools (except `ping`) accept these optional parameters:

| Parameter | Description |
|-----------|-------------|
| `detail` | Image resolution: `low` (768px, fastest), `medium` (1024px, default), `high` (1920px, best quality), `auto` (use tool default). Higher = more vision tokens = slower + costlier. |
| `max_tokens` | Max output tokens. Lower = faster. Suggested: 2048 for brief, 8192 for detailed, 16384 for screenshot trees. |
| `provider` | LLM provider name from config (default: `default_provider`). Use to select a different model per call. |
| `timeout` | Request timeout in milliseconds. Keep under 60000 to avoid MCP client timeout. |

---

## Configuration

### Three-layer merge (low → high priority)

```
config.json (project)  →  ~/.config/my-own-vision-mcp/my-own-vision-mcp.json (user)  →  env vars
```

### Project `config.json` (in repo, non-sensitive)

```json
{
  "llm": {
    "default_provider": "qwen",
    "providers": {
      "qwen": {
        "enable": true,
        "url": "https://your-api-endpoint/v1",
        "api_key": "YOUR_API_KEY",
        "model": "YOUR_MODEL",
        "max_tokens": 16384,
        "timeout": 120,
        "retry": {
          "max_retries": 3,
          "max_504_retries": 1,
          "base_delay": 1.0,
          "max_delay": 30.0,
          "jitter": 0.5,
          "retry_on_status": [429, 500, 502, 503, 504],
          "retry_504_delay": 10.0,
          "empty_retries": 3,
          "empty_retry_delay": 1.5
        }
      }
    }
  },
  "vision": {
    "max_image_dim": 1280,
    "jpeg_quality": 85,
    "max_image_size": 20971520,
    "url_timeout": 30,
    "detail_presets": {
      "low": 768,
      "medium": 1024,
      "high": 1920
    },
    "tools": {
      "extract_text": {
        "max_image_dim": 1920,
        "jpeg_quality": 90
      },
      "analyze_screenshot": {
        "max_image_dim": 1600
      }
    }
  },
  "logging": {
    "max_file_size": 1048576,
    "max_files": 10
  }
}
```

### User config `~/.config/my-own-vision-mcp/my-own-vision-mcp.json` (sensitive, not in repo)

```json
{
  "llm": {
    "providers": {
      "qwen": {
        "url": "https://your-real-endpoint/v1",
        "api_key": "sk-your-real-api-key"
      }
    }
  }
}
```

### Key config fields

| Field | Default | Description |
|-------|---------|-------------|
| `llm.providers.<name>.enable` | true | Set to false to disable a provider (won't be listed or callable) |
| `llm.providers.<name>.max_tokens` | 4096 | Max output tokens per request |
| `llm.providers.<name>.timeout` | 60 | Request timeout in seconds |
| `llm.providers.<name>.retry.*` | — | Retry config: `max_retries` (3), `max_504_retries` (1), `base_delay` (1s), `max_delay` (30s), `jitter` (0.5), `retry_on_status` ([429,500,502,503,504]), `empty_retries` (3), `empty_retry_delay` (1.5s) |
| `llm.providers.<name>.capabilities` | — | Per-provider vision capabilities (see AGENTS.md for details) |
| `vision.max_image_dim` | 1280 | Max image dimension (px) for preprocessing |
| `vision.jpeg_quality` | 85 | JPEG compression quality (1-100) |
| `vision.max_image_size` | 20MB | Max input image file size |
| `vision.url_timeout` | 30 | Timeout (s) for fetching images from URLs |
| `vision.detail_presets` | 768/1024/1920 | Pixel dimensions for `detail` = low/medium/high |
| `vision.tools.<tool>` | — | Per-tool overrides for `max_image_dim` and `jpeg_quality` |
| `logging.max_file_size` | 1MB | Log file rotation threshold |
| `logging.max_files` | 10 | Max rotated log files to keep |

### Environment variable overrides

| Variable | Purpose |
|----------|---------|
| `MY_OWN_VISION_MCP_CONFIG` | Override project config file path |
| `MY_OWN_VISION_MCP_API_KEY` | Override default provider's API key |
| `MY_OWN_VISION_MCP_CLIENT` | Client name for log file naming (e.g., `opencode`, `openclaw`) |

---

## Logging

Logs go to both **stderr** and **file** `logs/<client>.log` with auto-rotation.

- **Client name**: set via `MY_OWN_VISION_MCP_CLIENT` env var in the host's MCP config
- **Optional**: defaults to `default` → `logs/default.log`
- **Rotation**: file exceeds `logging.max_file_size` (default 1MB) → rotates, keeping at most `logging.max_files` (default 10) files
- **stdout is reserved for MCP protocol** — all logs go to stderr only

---

## Image preprocessing (optional)

Install `sharp` for resize/compress before sending to LLM:

```bash
npm install sharp
```

Without sharp, images are sent as-is (raw base64). With sharp, images are resized to `max_image_dim` and compressed to JPEG `jpeg_quality`. The loader also returns original/scaled dimensions so `analyze_screenshot` can scale bbox coordinates back to the original image.

---

## Development

```bash
npm run dev    # run via tsx (no build needed)
npm run build  # compile to dist/
npm start      # run compiled output
```

Tests (hand-written, no framework):

```bash
npx tsx test/image-loader-test.ts
npx tsx test/retry-test.ts
npx tsx test/analyze-screenshot-test.ts
npx tsx test/json-utils-test.ts
```

---

## Versioning

This project uses **dual versioning**:

| System | Where | Format | Example | Purpose |
|--------|-------|--------|---------|---------|
| **SemVer** | `package.json` `version` | `MAJOR.MINOR.PATCH` | `0.1.1` | Dependency compatibility |
| **CalVer** | Git tag + GitHub release | `vYYYY.MM.PATCH` | `v2026.09.0` | Release timeline |

- `package.json` version follows [Semantic Versioning](https://semver.org/) — breaking changes bump MAJOR, new features bump MINOR, fixes bump PATCH
- Git release tags follow calendar versioning — `v2026.09.0` is the first release in Sep 2026, `v2026.09.1` is the second, etc.
- Each GitHub release title shows both: `v2026.09.0 (SemVer 0.1.1)`

---

## Compatible LLM providers

Any endpoint that implements the OpenAI `POST /v1/chat/completions` format with vision support:

- **Qwen-VL** (Qwen-VL-Max, Qwen2-VL, Qwen3-VL, etc.) via DashScope or self-hosted
- **OpenAI GPT-4o** / GPT-4o-mini
- **Google Gemini** (Gemini 2.0 Flash, Gemini 1.5 Pro) via OpenAI-compatible proxy
- **GLM-4V** (Zhipu AI)
- **Llama Vision** (Llama 3.2 Vision) via Ollama / vLLM
- **Pixtral** (Mistral)
- **InternVL** (OpenVLM)
- **OpenRouter** — any vision model on OpenRouter (free tier supported)
- **Local models** via vLLM, Ollama, LM Studio, etc.

Configure multiple providers in `config.json` and select per-tool-call via the `provider` parameter.

---

## Contributing

Issues and PRs welcome! If this project saves you time or tokens, please ⭐ star the repo — it helps others find it.

## License

[MIT](LICENSE)
