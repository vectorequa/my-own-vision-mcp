import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROJECT_NAME = "my-own-vision-mcp";
const ENV_CONFIG = "MY_OWN_VISION_MCP_CONFIG";
const ENV_API_KEY = "MY_OWN_VISION_MCP_API_KEY";

export interface RetryConfig {
  max_retries: number;
  max_504_retries: number;
  base_delay: number;
  max_delay: number;
  jitter: number;
  retry_on_status: number[];
  retry_504_delay: number;
  empty_retries: number;
  empty_retry_delay: number;
}

export interface ProviderCapabilities {
  max_image_dim?: number;
  optimal_image_dim?: number;
  jpeg_quality?: number;
  max_image_size?: number;
  detail_presets?: {
    low?: number;
    medium?: number;
    high?: number;
  };
  best_for?: string[];
  supports_json_mode?: boolean;
  supports_multi_image?: boolean;
  rate_limit_tier?: "none" | "low" | "high";
  max_output_tokens?: number;
}

export interface ProviderConfig {
  enable: boolean;
  url: string;
  api_key: string;
  model: string;
  max_tokens: number;
  timeout: number;
  retry: RetryConfig;
  extra_notes?: string;
  capabilities?: ProviderCapabilities;
}

export interface VisionToolOverride {
  max_image_dim?: number;
  jpeg_quality?: number;
  max_image_size?: number;
  url_timeout?: number;
}

export interface DetailPresets {
  low: number;
  medium: number;
  high: number;
}

export interface VisionConfig {
  max_image_dim: number;
  jpeg_quality: number;
  max_image_size: number;
  url_timeout: number;
  detail_presets: DetailPresets;
  tools: Record<string, VisionToolOverride>;
}

export interface LoggingConfig {
  max_file_size: number;
  max_files: number;
}

export interface AppConfig {
  llm: {
    default_provider: string;
    providers: Record<string, ProviderConfig>;
  };
  vision: VisionConfig;
  logging: LoggingConfig;
}

function deepMerge(base: any, override: any): any {
  if (override === null || override === undefined) return base;
  if (base === null || base === undefined) return override;
  if (typeof base !== "object" || typeof override !== "object") return override;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    result[key] = deepMerge(base[key], override[key]);
  }
  return result;
}

function findProjectConfig(): string {
  const envPath = process.env[ENV_CONFIG];
  if (envPath && existsSync(envPath)) return envPath;

  const pkgPath = join(__dirname, "..", "config.json");
  if (existsSync(pkgPath)) return pkgPath;

  const cwdPath = join(process.cwd(), "config.json");
  if (existsSync(cwdPath)) return cwdPath;

  throw new Error(`config.json not found (searched ${ENV_CONFIG}, package dir, cwd)`);
}

function userConfigPath(): string {
  return join(homedir(), ".config", PROJECT_NAME, `${PROJECT_NAME}.json`);
}

export function getConfigPaths(): { project: string; user: string | null } {
  const project = findProjectConfig();
  const user = userConfigPath();
  return { project, user: existsSync(user) ? user : null };
}

export function loadConfig(): AppConfig {
  const projectConfigPath = findProjectConfig();
  const projectRaw = JSON.parse(readFileSync(projectConfigPath, "utf-8"));

  const userPath = userConfigPath();
  let userRaw: any = {};
  if (existsSync(userPath)) {
    userRaw = JSON.parse(readFileSync(userPath, "utf-8"));
  }

  const raw = deepMerge(projectRaw, userRaw);

  if (!raw.llm?.providers) throw new Error("config: llm.providers missing");
  if (!raw.llm.default_provider) throw new Error("config: llm.default_provider missing");

  const envKey = process.env[ENV_API_KEY];
  for (const [name, p] of Object.entries(raw.llm.providers)) {
    const provider = p as ProviderConfig;
    if (provider.enable === undefined) provider.enable = true;
    if (!provider.url) {
      throw new Error(
        `config: provider '${name}' missing url — set it in ~/.config/${PROJECT_NAME}/${PROJECT_NAME}.json`,
      );
    }
    if (!provider.api_key || provider.api_key === "YOUR_API_KEY") {
      if (envKey) {
        provider.api_key = envKey;
      } else {
        throw new Error(
          `config: provider '${name}' api_key not set — set it in ~/.config/${PROJECT_NAME}/${PROJECT_NAME}.json or env ${ENV_API_KEY}`,
        );
      }
    }
    if (!provider.model || provider.model === "YOUR_MODEL") {
      throw new Error(
        `config: provider '${name}' model not set — set it in ~/.config/${PROJECT_NAME}/${PROJECT_NAME}.json`,
      );
    }
    if (!provider.max_tokens) provider.max_tokens = 4096;
    if (!provider.timeout) provider.timeout = 60;
    if (!provider.retry) provider.retry = {} as RetryConfig;
    const r = provider.retry;
    if (r.max_retries === undefined) r.max_retries = 3;
    if (r.base_delay === undefined) r.base_delay = 1.0;
    if (r.max_delay === undefined) r.max_delay = 30.0;
    if (r.jitter === undefined) r.jitter = 0.5;
    if (!r.retry_on_status) r.retry_on_status = [429, 500, 502, 503, 504];
    if (r.retry_504_delay === undefined) r.retry_504_delay = 10.0;
    if (r.max_504_retries === undefined) r.max_504_retries = 1;
    if (r.empty_retries === undefined) r.empty_retries = 3;
    if (r.empty_retry_delay === undefined) r.empty_retry_delay = 1.5;
  }

  if (!raw.vision) raw.vision = {};
  if (!raw.vision.max_image_dim) raw.vision.max_image_dim = 1280;
  if (!raw.vision.jpeg_quality) raw.vision.jpeg_quality = 85;
  if (!raw.vision.max_image_size) raw.vision.max_image_size = 20 * 1024 * 1024;
  if (!raw.vision.url_timeout) raw.vision.url_timeout = 30;
  if (!raw.vision.detail_presets) raw.vision.detail_presets = { low: 768, medium: 1024, high: 1920 };
  if (!raw.vision.tools) raw.vision.tools = {};

  const defaultProvider = raw.llm.providers[raw.llm.default_provider] as ProviderConfig | undefined;
  if (defaultProvider && !defaultProvider.enable) {
    log("WARN", "config", "default provider is disabled", { provider: raw.llm.default_provider });
  }

  if (!raw.logging) raw.logging = {};
  if (!raw.logging.max_file_size) raw.logging.max_file_size = 1048576;
  if (!raw.logging.max_files) raw.logging.max_files = 10;

  log("INFO", "config", "loaded", { project: projectConfigPath, user: existsSync(userPath) ? userPath : "(none)" });

  return raw as AppConfig;
}

export function getProvider(config: AppConfig, name?: string): ProviderConfig {
  const providerName = name || config.llm.default_provider;
  const provider = config.llm.providers[providerName];
  if (!provider) throw new Error(`provider '${providerName}' not found in config`);
  if (!provider.enable) throw new Error(`provider '${providerName}' is disabled (enable=false)`);
  return provider;
}

export function getEnabledProviders(config: AppConfig): Record<string, ProviderConfig> {
  const result: Record<string, ProviderConfig> = {};
  for (const [name, p] of Object.entries(config.llm.providers)) {
    if (p.enable) result[name] = p;
  }
  return result;
}

export function getVisionForTool(config: AppConfig, toolName: string): VisionConfig {
  const base = config.vision;
  const override = base.tools?.[toolName];
  if (!override) return base;
  return {
    ...base,
    ...override,
    detail_presets: base.detail_presets,
    tools: base.tools,
  };
}

export function resolveDetail(
  config: AppConfig,
  toolName: string,
  detail: "low" | "medium" | "high" | "auto" | undefined,
): number | undefined {
  if (!detail || detail === "auto") return undefined;
  return config.vision.detail_presets[detail];
}

export function getProviderCapabilities(config: AppConfig, providerName?: string): ProviderCapabilities {
  const name = providerName || config.llm.default_provider;
  return config.llm.providers[name]?.capabilities || {};
}

export function resolveProviderImageDim(
  config: AppConfig,
  toolName: string,
  providerName: string | undefined,
  detail: "low" | "medium" | "high" | "auto" | undefined,
): { maxImageDim?: number; jpegQuality?: number } {
  const caps = getProviderCapabilities(config, providerName);
  const toolOverride = config.vision.tools?.[toolName];

  let maxImageDim: number | undefined;
  let jpegQuality: number | undefined;

  if (detail && detail !== "auto") {
    const preset = caps.detail_presets?.[detail];
    if (preset !== undefined) {
      maxImageDim = preset;
    } else {
      maxImageDim = config.vision.detail_presets[detail];
    }
  }

  if (maxImageDim === undefined) {
    maxImageDim = caps.optimal_image_dim;
  }

  if (maxImageDim === undefined) {
    maxImageDim = toolOverride?.max_image_dim;
  }

  if (maxImageDim === undefined) {
    maxImageDim = config.vision.max_image_dim;
  }

  if (caps.max_image_dim !== undefined && maxImageDim > caps.max_image_dim) {
    maxImageDim = caps.max_image_dim;
  }

  jpegQuality = caps.jpeg_quality ?? toolOverride?.jpeg_quality ?? config.vision.jpeg_quality;

  return { maxImageDim, jpegQuality };
}
