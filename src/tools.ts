import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { getProvider, getVisionForTool, resolveProviderImageDim, getEnabledProviders } from "./config.js";
import { LLMClient } from "./llm-client.js";
import { imageToBase64 } from "./image-loader.js";
import { safeJsonParse } from "./json-utils.js";
import { log, nextReqId, describeImageSource } from "./logger.js";

type GetConfig = () => AppConfig;

const DEFAULT_RECOGNIZE_PROMPT = "请详细描述这张图片的内容";
const DEFAULT_OCR_PROMPT = "请提取图片中的所有文字内容，保持原始布局和换行，只返回提取的文字";
const DEFAULT_COMPARE_PROMPT = "请对比这两张图片，描述它们的相同点和不同点";

const DEFAULT_SCREENSHOT_AXTREE_PROMPT = `你是一个 GUI 结构提取器。分析这张截图，输出一棵无障碍树（accessibility tree）表示页面的 UI 结构。

截图类型可能是网页、桌面窗体、移动端 App 或文档扫描页。先判断类型，再用统一的 role 词表输出。

输出要求：
1. 用缩进表示层级（每层 2 个空格）
2. 每行格式：role "name" [ref=N] [box=x,y,w,h] [可选属性=值 ...]
3. 只给可交互元素分配 ref 编号（link/button/textbox/searchbox/checkbox/radio/combobox/listbox/tab/img/menuitem 等），纯容器和纯文本不给 ref
4. box 是 [x, y, width, height]，左上角原点，基于你看到的图像像素坐标系
5. role 词表（统一网页+窗体）：page/window/navigation/menubar/toolbar/main/heading/link/button/textbox/searchbox/checkbox/radio/combobox/listbox/listitem/table/row/cell/img/icon/tab/tabpanel/dialog/menu/menuitem/statusbar/scrollbar/text/group
6. name 用元素显示的可见文本；无文本则用 aria-label/placeholder/alt，都没有则空字符串 ""
7. 忽略不可见元素（display:none/visibility:hidden/完全超出视口）
8. 保持空间顺序：从上到下、从左到右
9. 可选属性：level/placeholder/checked/disabled/href/alt/value/expanded/selected

只输出树本身，不要解释、不要 markdown 代码块、不要前后缀。`;

const DEFAULT_SCREENSHOT_JSON_PROMPT = `你是一个 GUI 结构提取器。分析这张截图，输出页面的 UI 结构为 JSON。

截图类型可能是网页、桌面窗体、移动端 App 或文档扫描页。先判断类型，再用统一的 type 词表输出。

输出要求：
1. 输出单个 JSON 对象，表示根节点（type 为 page 或 window）
2. 每个节点字段：type（必填）、name（显示文本，必填）、bbox（[x,y,width,height]，必填）、ref（仅可交互元素给整数编号）、children（子节点数组，可选）、其他可选属性（level/placeholder/checked/disabled/href/alt/value/expanded/selected）
3. 只给可交互元素分配 ref（link/button/textbox/searchbox/checkbox/radio/combobox/listbox/tab/img/menuitem 等）
4. bbox 基于你看到的图像像素坐标系，左上角原点
5. type 词表：page/window/navigation/menubar/toolbar/main/heading/link/button/textbox/searchbox/checkbox/radio/combobox/listbox/listitem/table/row/cell/img/icon/tab/tabpanel/dialog/menu/menuitem/statusbar/scrollbar/text/group
6. 忽略不可见元素，保持空间顺序（上到下、左到右）
7. 只输出 raw JSON，不要 markdown 代码块、不要解释`;

type ToolResult = { content: [{ type: "text"; text: string }] };

function makeClient(config: AppConfig, providerName?: string): LLMClient {
  const provider = getProvider(config, providerName);
  return new LLMClient(provider);
}

function errorResponse(tool: string, e: unknown, reqId: string): ToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  log("ERROR", "tool", "call failed", { call: tool, reqId, error: msg });
  return { content: [{ type: "text", text: JSON.stringify({ error: msg, data: null }) }] };
}

function buildProviderList(config: AppConfig): string {
  const enabled = getEnabledProviders(config);
  const entries = Object.entries(enabled).map(([name, p]) => {
    const role = p.extra_notes?.match(/^\[([^\]]+)\]/)?.[1] || "";
    const caps = p.capabilities;
    const maxDim = caps?.max_image_dim ?? config.vision.max_image_dim;
    const optimal = caps?.optimal_image_dim ?? config.vision.max_image_dim;
    const bestFor = caps?.best_for?.join("/") ?? "";
    return `  - ${name} [${role}] max=${maxDim}px optimal=${optimal}px${bestFor ? ` best_for=${bestFor}` : ""}`;
  });
  return `Available providers (pass as 'provider' param):\n${entries.join("\n")}\nCall ping for full details.`;
}

const detailParam = z.enum(["low", "medium", "high", "auto"]).optional().describe(
  "Image resolution. 'low' (768px): fastest, for quick overview or small images. " +
  "'medium' (1024px): balanced, good for general description. " +
  "'high' (1920px): slowest, for OCR or fine detail — may timeout on large images. " +
  "'auto': use tool's configured default. " +
  "Higher resolution = more vision tokens = slower response and higher timeout risk."
);

const maxTokensParam = z.number().optional().describe(
  "Max output tokens. Lower = faster response. " +
  "Suggested: 2048 for brief descriptions, 8192 for detailed analysis, 16384 for screenshot trees."
);

const timeoutParam = z.number().optional().describe(
  "Request timeout in milliseconds. Keep under 60000 to avoid MCP client timeout (-32001 error)."
);

function computeImageOverrides(
  config: AppConfig,
  toolName: string,
  providerName: string | undefined,
  detail: "low" | "medium" | "high" | "auto" | undefined,
): { maxImageDim?: number; jpegQuality?: number } {
  return resolveProviderImageDim(config, toolName, providerName, detail);
}

async function runTool(
  name: string,
  startFields: Record<string, unknown>,
  fn: (reqId: string) => Promise<string>,
): Promise<ToolResult> {
  const reqId = nextReqId();
  const t0 = Date.now();
  log("INFO", "tool", "call start", { call: name, reqId, ...startFields });
  try {
    const text = await fn(reqId);
    log("INFO", "tool", "call done", { call: name, reqId, duration: `${Date.now() - t0}ms` });
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return errorResponse(name, e, reqId);
  }
}

export function scaleBboxAxtree(text: string, scale: number): string {
  if (scale === 1) return text;
  return text.replace(/\[box=([\d.]+),([\d.]+),([\d.]+),([\d.]+)\]/g, (_, x, y, w, h) => {
    return `[box=${Math.round(Number(x) * scale)},${Math.round(Number(y) * scale)},${Math.round(Number(w) * scale)},${Math.round(Number(h) * scale)}]`;
  });
}

export function scaleBboxJson(obj: unknown, scale: number): void {
  if (scale === 1) return;
  if (Array.isArray(obj)) {
    for (const item of obj) scaleBboxJson(item, scale);
    return;
  }
  if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    if (Array.isArray(o.bbox) && o.bbox.length === 4 && o.bbox.every((n) => typeof n === "number")) {
      o.bbox = (o.bbox as number[]).map((n) => Math.round(n * scale));
    }
    for (const v of Object.values(o)) scaleBboxJson(v, scale);
  }
}

export function registerTools(server: McpServer, getConfig: GetConfig): void {
  const config = getConfig();
  const providerList = buildProviderList(config);
  const defaultProvider = config.llm.providers[config.llm.default_provider];
  const modelNotes = defaultProvider?.extra_notes
    ? `\n\n[Active model: ${defaultProvider.model}] ${defaultProvider.extra_notes}`
    : "";
  const providerInfo = `\n\n${providerList}${modelNotes}`;

  server.tool(
    "analyze_image",
    (    "Analyze an image and return a text description. Supports file path, base64, or URL. " +
    "Use detail='low' for quick overview, 'medium' for general description (default), 'high' for detail-sensitive tasks. " +
    "For multiple images, call once per image. Avoid high concurrency to prevent timeouts.") + providerInfo,
    {
      image: z.string().describe("Image source: file path, base64 string, or URL (http/https)"),
      prompt: z.string().optional().describe("Analysis prompt (default: describe the image content)"),
      detail: detailParam,
      max_tokens: maxTokensParam,
      provider: z.string().optional().describe("LLM provider name (default: from config)"),
      timeout: timeoutParam,
    },
    async (p) => runTool("analyze_image", { image: describeImageSource(p.image) }, async () => {
      const config = getConfig();
      const prompt = p.prompt || DEFAULT_RECOGNIZE_PROMPT;
      const client = makeClient(config, p.provider);
      const vision = getVisionForTool(config, "analyze_image");
      const overrides = computeImageOverrides(config, "analyze_image", p.provider, p.detail);
      const { base64, mimeType } = await imageToBase64(p.image, vision, overrides);
      return client.visionChat(prompt, base64, mimeType, { maxTokens: p.max_tokens, timeout: p.timeout });
    }),
  );

  server.tool(
    "compare_images",
    (    "Compare two images and describe their similarities and differences. " +
    "Use detail='low' or 'medium' for most comparisons. " +
    "Both images are preprocessed independently at the same resolution.") + providerInfo,
    {
      image1: z.string().describe("First image source (file path, base64, or URL)"),
      image2: z.string().describe("Second image source (file path, base64, or URL)"),
      prompt: z.string().optional().describe("Comparison prompt (default: describe similarities and differences)"),
      detail: detailParam,
      max_tokens: maxTokensParam,
      provider: z.string().optional().describe("LLM provider name"),
      timeout: timeoutParam,
    },
    async (p) => runTool("compare_images", { image1: describeImageSource(p.image1), image2: describeImageSource(p.image2) }, async () => {
      const config = getConfig();
      const prompt = p.prompt || DEFAULT_COMPARE_PROMPT;
      const client = makeClient(config, p.provider);
      const vision = getVisionForTool(config, "compare_images");
      const overrides = computeImageOverrides(config, "compare_images", p.provider, p.detail);
      const [img1, img2] = await Promise.all([
        imageToBase64(p.image1, vision, overrides),
        imageToBase64(p.image2, vision, overrides),
      ]);
      return client.visionChatMultiImage(prompt, [
        { base64: img1.base64, mimeType: img1.mimeType },
        { base64: img2.base64, mimeType: img2.mimeType },
      ], { maxTokens: p.max_tokens, timeout: p.timeout });
    }),
  );

  server.tool(
    "extract_text",
    (    "OCR: extract all text from an image, preserving original layout and line breaks. " +
    "Use detail='high' for small or dense text for better recognition. " +
    "High resolution on large images may cause timeout; if so, retry with a lower detail level.") + providerInfo,
    {
      image: z.string().describe("Image source (file path, base64, or URL)"),
      detail: detailParam,
      max_tokens: maxTokensParam,
      provider: z.string().optional().describe("LLM provider name"),
      timeout: timeoutParam,
    },
    async (p) => runTool("extract_text", { image: describeImageSource(p.image) }, async () => {
      const config = getConfig();
      const client = makeClient(config, p.provider);
      const vision = getVisionForTool(config, "extract_text");
      const overrides = computeImageOverrides(config, "extract_text", p.provider, p.detail);
      const { base64, mimeType } = await imageToBase64(p.image, vision, overrides);
      return client.visionChat(DEFAULT_OCR_PROMPT, base64, mimeType, { maxTokens: p.max_tokens, timeout: p.timeout });
    }),
  );

  server.tool(
    "extract_structured",
    (    "Analyze an image and extract structured information as JSON, guided by a schema description. " +
    "Use detail='high' for field-level precision (small text, fine details), 'medium' for general structured data. " +
    "Pass a custom `prompt` to override the auto-generated extraction instructions.") + providerInfo,
    {
      image: z.string().describe("Image source (file path, base64, or URL)"),
      schema: z.string().describe("JSON schema description (e.g. '{\"name\": string, \"age\": number}')"),
      prompt: z.string().optional().describe("Custom prompt (default: auto-generated from schema)"),
      detail: detailParam,
      max_tokens: maxTokensParam,
      provider: z.string().optional().describe("LLM provider name"),
      timeout: timeoutParam,
    },
    async (p) => runTool("extract_structured", { image: describeImageSource(p.image) }, async (reqId) => {
      const config = getConfig();
      const prompt = p.prompt || `Analyze the image and extract information into JSON. You MUST use exactly the field names defined in the schema below. Do not add, remove, or rename fields. Do not wrap in markdown code blocks. Return only raw JSON.\nSchema:\n${p.schema}`;
      const client = makeClient(config, p.provider);
      const vision = getVisionForTool(config, "extract_structured");
      const overrides = computeImageOverrides(config, "extract_structured", p.provider, p.detail);
      const { base64, mimeType } = await imageToBase64(p.image, vision, overrides);
      const response = await client.visionChat(prompt, base64, mimeType, { jsonMode: true, maxTokens: p.max_tokens, timeout: p.timeout });
      const parsed = safeJsonParse(response);
      if (parsed !== null) return JSON.stringify(parsed);

      log("WARN", "tool", "first parse failed, retrying", { call: "extract_structured", reqId });
      const retryPrompt = `Your previous response was not valid JSON. Return ONLY raw JSON, no markdown, no explanation. Schema:\n${p.schema}`;
      const response2 = await client.visionChat(retryPrompt, base64, mimeType, { jsonMode: true, maxTokens: p.max_tokens, timeout: p.timeout });
      const parsed2 = safeJsonParse(response2);
      if (parsed2 !== null) return JSON.stringify(parsed2);

      log("ERROR", "tool", "parse failed after retry", { call: "extract_structured", reqId });
      return JSON.stringify({ error: "JSON parse failed after retry", raw: response2.slice(0, 500) });
    }),
  );

  server.tool(
    "analyze_screenshot",
    (    "Extract UI structure tree from a GUI screenshot (webpage / desktop window / mobile app). " +
    "Returns accessibility tree with role, ref, and bbox per element. Use this for screenshots only; for general images use analyze_image. " +
    "Use detail='medium' or 'auto' for most screenshots. format='json' produces more tokens than 'axtree'. " +
    "Set max_elements to prevent token overflow on complex UIs. " +
    "Pass `prompt` for extra extraction instructions appended to the built-in prompt.") + providerInfo,
    {
      image: z.string().describe("Screenshot source (file path, base64, or URL) — must be a GUI screenshot, not a general photo"),
      format: z.enum(["axtree", "json"]).optional().describe("Output format: axtree (default, indented text tree) or json (nested JSON object)"),
      max_elements: z.number().optional().describe("Max element count to prevent token overflow; excess truncated by visual importance"),
      detail: detailParam,
      max_tokens: maxTokensParam,
      prompt: z.string().optional().describe("Extra instructions appended to the built-in extraction prompt"),
      provider: z.string().optional().describe("LLM provider name"),
      timeout: timeoutParam,
    },
    async (p) => {
      const format = p.format || "axtree";
      return runTool("analyze_screenshot", { image: describeImageSource(p.image), format }, async (reqId) => {
        const config = getConfig();
        const client = makeClient(config, p.provider);
        const vision = getVisionForTool(config, "analyze_screenshot");
        const overrides = computeImageOverrides(config, "analyze_screenshot", p.provider, p.detail);
        const img = await imageToBase64(p.image, vision, overrides);
        const scale = img.scaledWidth > 0 && img.origWidth > 0 ? img.origWidth / img.scaledWidth : 1;

        const basePrompt = format === "json" ? DEFAULT_SCREENSHOT_JSON_PROMPT : DEFAULT_SCREENSHOT_AXTREE_PROMPT;
        let prompt = p.prompt ? `${p.prompt}\n\n${basePrompt}` : basePrompt;
        if (p.max_elements) {
          prompt += `\n\nLimit: output at most ${p.max_elements} elements, truncate by visual importance if exceeded, mark with [truncated]`;
        }

        const jsonMode = format === "json";
        const response = await client.visionChat(prompt, img.base64, img.mimeType, { jsonMode, maxTokens: p.max_tokens, timeout: p.timeout });

        let resultText: string;
        if (jsonMode) {
          const parsed = safeJsonParse(response);
          if (parsed !== null) {
            scaleBboxJson(parsed, scale);
            resultText = JSON.stringify(parsed, null, 2);
          } else {
            log("WARN", "tool", "first parse failed, retrying", { call: "analyze_screenshot", reqId });
            const retryPrompt = `Your previous response was not valid JSON. Return ONLY raw JSON, no markdown, no explanation.\n\n${basePrompt}`;
            const response2 = await client.visionChat(retryPrompt, img.base64, img.mimeType, { jsonMode: true, maxTokens: p.max_tokens, timeout: p.timeout });
            const parsed2 = safeJsonParse(response2);
            if (parsed2 !== null) {
              scaleBboxJson(parsed2, scale);
              resultText = JSON.stringify(parsed2, null, 2);
            } else {
              log("ERROR", "tool", "parse failed after retry", { call: "analyze_screenshot", reqId });
              resultText = JSON.stringify({ error: "JSON parse failed after retry", raw: response2.slice(0, 500) });
            }
          }
        } else {
          resultText = scaleBboxAxtree(response, scale);
        }

        const meta = { origWidth: img.origWidth, origHeight: img.origHeight, scaledWidth: img.scaledWidth, scaledHeight: img.scaledHeight, scale: Number(scale.toFixed(4)) };
        const note = img.origWidth === 0 ? "\n\n[note: original dimensions unknown (sharp fallback), bbox not scaled]" : "";
        return `${resultText}${note}\n\n[meta: ${JSON.stringify(meta)}]`;
      });
    },
  );

  server.tool(
    "ping",
    "Check MCP server health and configuration. Returns status, provider, model, and config info. " +
    "Call this to discover all available providers and their capabilities.",
    {},
    async () => runTool("ping", {}, async () => {
      const config = getConfig();
      const providerName = config.llm.default_provider;
      const provider = config.llm.providers[providerName];
      const enabled = getEnabledProviders(config);
      const allProviders: Record<string, { model: string; enable: boolean; extra_notes?: string; capabilities?: any }> = {};
      for (const [name, p] of Object.entries(enabled)) {
        allProviders[name] = { model: p.model, enable: p.enable, extra_notes: p.extra_notes, capabilities: p.capabilities };
      }
      return JSON.stringify({
        status: "ok",
        provider: providerName,
        model: provider?.model,
        max_tokens: provider?.max_tokens,
        timeout: provider?.timeout,
        max_504_retries: provider?.retry?.max_504_retries,
        max_retries: provider?.retry?.max_retries,
        extra_notes: provider?.extra_notes,
        capabilities: provider?.capabilities,
        all_providers: allProviders,
        vision: {
          max_image_dim: config.vision.max_image_dim,
          jpeg_quality: config.vision.jpeg_quality,
          detail_presets: config.vision.detail_presets,
          tools: config.vision.tools,
        },
      }, null, 2);
    }),
  );
}
