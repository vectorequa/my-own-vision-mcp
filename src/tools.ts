import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { getProvider, resolveProviderImageDim, getEnabledProviders } from "./config.js";
import { LLMClient } from "./llm-client.js";
import { imageToBase64 } from "./image-loader.js";
import { safeJsonParse } from "./json-utils.js";
import { log, nextReqId, describeImageSource } from "./logger.js";

type GetConfig = () => AppConfig;

const DEFAULT_RECOGNIZE_PROMPT = "Describe this image in detail.";
const DEFAULT_OCR_PROMPT = "Extract ALL text from the image exactly as shown, preserving original layout and line breaks. The text may be in any language (Thai, Chinese, English, Korean, Japanese, Arabic, etc.). Return only the extracted text, no explanation or commentary.";
const DEFAULT_COMPARE_PROMPT = "Compare these two images. Describe their similarities and differences.";

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

const maxTokensParam = z.number().optional().describe(
  "Max output tokens. 2048=brief, 8192=detailed, 16384=large."
);

function computeImageOverrides(
  config: AppConfig,
  providerName: string | undefined,
): { maxImageDim?: number; jpegQuality?: number } {
  return resolveProviderImageDim(config, providerName);
}

const TASK_BEST_FOR: Record<string, string[]> = {
  extract_text: ["ocr", "multilingual", "document"],
  analyze_image: ["screenshot", "photo", "document"],
  extract_structured: ["json", "document", "screenshot"],
};

const RATE_TIER_ORDER: Record<string, number> = { none: 0, low: 1, high: 2 };

const providerHealth: Map<string, { failCount: number; cooldownUntil: number }> = new Map();

function markProviderFailure(providerName: string): void {
  const entry = providerHealth.get(providerName) || { failCount: 0, cooldownUntil: 0 };
  entry.failCount++;
  const cooldownMs = Math.min(30000 * Math.pow(2, entry.failCount - 1), 300000);
  entry.cooldownUntil = Date.now() + cooldownMs;
  providerHealth.set(providerName, entry);
  log("WARN", "tool", "provider marked unhealthy", { provider: providerName, failCount: entry.failCount, cooldownMs });
}

function markProviderSuccess(providerName: string): void {
  const entry = providerHealth.get(providerName);
  if (entry && entry.failCount > 0) {
    providerHealth.delete(providerName);
    log("INFO", "tool", "provider recovered", { provider: providerName });
  }
}

function isProviderHealthy(providerName: string): boolean {
  const entry = providerHealth.get(providerName);
  if (!entry) return true;
  return Date.now() >= entry.cooldownUntil;
}

function getOrderedProviders(config: AppConfig, toolName: string): string[] {
  const enabled = getEnabledProviders(config);
  const desired = TASK_BEST_FOR[toolName] || [];

  return Object.entries(enabled)
    .filter(([, p]) => !p.extra_notes?.includes("[UNUSABLE]"))
    .sort(([, pA], [, pB]) => {
      const bestForA = pA.capabilities?.best_for || [];
      const bestForB = pB.capabilities?.best_for || [];
      const scoreA = desired.filter((d) => bestForA.includes(d)).length;
      const scoreB = desired.filter((d) => bestForB.includes(d)).length;
      if (scoreA !== scoreB) return scoreB - scoreA;

      const tierA = pA.capabilities?.rate_limit_tier || "low";
      const tierB = pB.capabilities?.rate_limit_tier || "low";
      return (RATE_TIER_ORDER[tierA] ?? 1) - (RATE_TIER_ORDER[tierB] ?? 1);
    })
    .map(([name]) => name);
}

async function withFallback<T>(
  config: AppConfig,
  toolName: string,
  fn: (providerName: string, timeout: number) => Promise<T>,
): Promise<{ result: T; provider: string }> {
  const allProviders = getOrderedProviders(config, toolName);
  const providers = allProviders.filter((name) => {
    if (!isProviderHealthy(name)) {
      const entry = providerHealth.get(name)!;
      const remaining = Math.ceil((entry.cooldownUntil - Date.now()) / 1000);
      log("INFO", "tool", "skipping unhealthy provider", { provider: name, cooldownRemaining: `${remaining}s` });
      return false;
    }
    return true;
  });

  if (providers.length === 0) {
    log("WARN", "tool", "all providers unhealthy, retrying all", { tool: toolName });
    providers.push(...allProviders);
  }

  const totalBudget = 55000;
  const deadline = Date.now() + totalBudget;
  const errors: string[] = [];

  for (const providerName of providers) {
    const remaining = deadline - Date.now();
    if (remaining < 5000) {
      log("WARN", "tool", "fallback budget exhausted", { skipped: providers.slice(providers.indexOf(providerName)).join(",") });
      break;
    }

    const timeout = Math.min(40000, remaining);
    try {
      const result = await fn(providerName, timeout);
      markProviderSuccess(providerName);
      if (providerName !== config.llm.default_provider) {
        log("INFO", "tool", "fallback succeeded", { provider: providerName, tool: toolName });
      }
      return { result, provider: providerName };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markProviderFailure(providerName);
      errors.push(`${providerName}: ${msg.slice(0, 200)}`);
      log("WARN", "tool", "provider failed, trying next", { provider: providerName, error: msg.slice(0, 200) });
    }
  }

  throw new Error(`All providers failed:\n${errors.join("\n")}`);
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

export function registerTools(server: McpServer, getConfig: GetConfig): void {
  server.tool(
    "analyze_image",
    "Analyze or compare image(s). Pass single image or array for multi-image. " +
    "Auto-selects best provider. Supports custom prompt for any vision task.",
    {
      image: z.string().or(z.array(z.string())).describe("Image path/base64/URL, or array for multiple images"),
      prompt: z.string().optional().describe("Custom analysis prompt (default: describe, or compare if multiple images)"),
      max_tokens: maxTokensParam,
    },
    async (p) => runTool("analyze_image", { image: Array.isArray(p.image) ? `${p.image.length} images` : describeImageSource(p.image) }, async () => {
      const config = getConfig();
      const images = Array.isArray(p.image) ? p.image : [p.image];
      const prompt = p.prompt || (images.length > 1 ? DEFAULT_COMPARE_PROMPT : DEFAULT_RECOGNIZE_PROMPT);
      const { result } = await withFallback(config, "analyze_image", async (providerName, timeout) => {
        const client = makeClient(config, providerName);
        const overrides = computeImageOverrides(config, providerName);
        const encoded = await Promise.all(images.map((src) => imageToBase64(src, config.vision, overrides)));
        if (encoded.length === 1) {
          return client.visionChat(prompt, encoded[0].base64, encoded[0].mimeType, { maxTokens: p.max_tokens, timeout });
        }
        return client.visionChatMultiImage(prompt, encoded.map((e) => ({ base64: e.base64, mimeType: e.mimeType })), { maxTokens: p.max_tokens, timeout });
      });
      return result;
    }),
  );

  server.tool(
    "extract_text",
    "OCR: extract all text from image, preserving layout. Auto-detects any language. " +
    "Resolution follows provider capability (max_image_dim).",
    {
      image: z.string().describe("Image path, base64, or URL"),
      max_tokens: maxTokensParam,
    },
    async (p) => runTool("extract_text", { image: describeImageSource(p.image) }, async () => {
      const config = getConfig();
      const { result } = await withFallback(config, "extract_text", async (providerName, timeout) => {
        const client = makeClient(config, providerName);
        const overrides = computeImageOverrides(config, providerName);
        const { base64, mimeType } = await imageToBase64(p.image, config.vision, overrides);
        return client.visionChat(DEFAULT_OCR_PROMPT, base64, mimeType, { maxTokens: p.max_tokens, timeout });
      });
      return result;
    }),
  );

  server.tool(
    "extract_structured",
    "Extract fields as JSON from image, guided by schema. Best for forms, tables, invoices, documents. " +
    "Auto-retries on JSON parse failure.",
    {
      image: z.string().describe("Image path, base64, or URL"),
      schema: z.string().describe("JSON schema (e.g. '{\"name\": string, \"age\": number}')"),
      prompt: z.string().optional().describe("Custom extraction prompt (default: auto-generated from schema)"),
      max_tokens: maxTokensParam,
    },
    async (p) => runTool("extract_structured", { image: describeImageSource(p.image) }, async (reqId) => {
      const config = getConfig();
      const prompt = p.prompt || `Analyze the image and extract information into JSON. You MUST use exactly the field names defined in the schema below. Do not add, remove, or rename fields. Do not wrap in markdown code blocks. Return only raw JSON.\nSchema:\n${p.schema}`;
      const { result: response, provider: usedProvider } = await withFallback(config, "extract_structured", async (providerName, timeout) => {
        const client = makeClient(config, providerName);
        const overrides = computeImageOverrides(config, providerName);
        const { base64, mimeType } = await imageToBase64(p.image, config.vision, overrides);
        return client.visionChat(prompt, base64, mimeType, { jsonMode: true, maxTokens: p.max_tokens, timeout });
      });
      const parsed = safeJsonParse(response);
      if (parsed !== null) return JSON.stringify(parsed);

      log("WARN", "tool", "first parse failed, retrying", { call: "extract_structured", reqId });
      const retryPrompt = `Your previous response was not valid JSON. Return ONLY raw JSON, no markdown, no explanation. Schema:\n${p.schema}`;
      const { result: response2 } = await withFallback(config, "extract_structured", async (providerName, timeout) => {
        const client = makeClient(config, providerName);
        const overrides = computeImageOverrides(config, providerName);
        const { base64, mimeType } = await imageToBase64(p.image, config.vision, overrides);
        return client.visionChat(retryPrompt, base64, mimeType, { jsonMode: true, maxTokens: p.max_tokens, timeout });
      });
      const parsed2 = safeJsonParse(response2);
      if (parsed2 !== null) return JSON.stringify(parsed2);

      log("ERROR", "tool", "parse failed after retry", { call: "extract_structured", reqId });
      return JSON.stringify({ error: "JSON parse failed after retry", raw: response2.slice(0, 500) });
    }),
  );

  server.tool(
    "ping",
    "Check server health, provider list, and configuration.",
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
        extra_notes: provider?.extra_notes,
        capabilities: provider?.capabilities,
        all_providers: allProviders,
        vision: {
          max_image_dim: config.vision.max_image_dim,
          jpeg_quality: config.vision.jpeg_quality,
        },
      }, null, 2);
    }),
  );
}
