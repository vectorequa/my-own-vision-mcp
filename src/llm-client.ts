import type { ProviderConfig, RetryConfig } from "./config.js";
import { log } from "./logger.js";

export interface ChatMessage {
  role: string;
  content: string | ContentPart[];
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export class LLMError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "LLMError";
  }
}

export class LLMHttpError extends LLMError {
  constructor(
    message: string,
    public status: number,
    public retryAfter?: number,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = "LLMHttpError";
  }
}

export class LLMNetworkError extends LLMError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "LLMNetworkError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) return seconds;
  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    return Math.max(0, (date.getTime() - Date.now()) / 1000);
  }
  return undefined;
}

export class LLMClient {
  private url: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private timeout: number;
  private retry: RetryConfig;

  constructor(provider: ProviderConfig) {
    this.url = `${provider.url.replace(/\/+$/, "")}/chat/completions`;
    this.apiKey = provider.api_key;
    this.model = provider.model;
    this.maxTokens = provider.max_tokens;
    this.timeout = provider.timeout * 1000;
    this.retry = provider.retry;
  }

  private calcDelay(
    status: number | undefined,
    retryAfter: number | undefined,
    attempt: number,
  ): number {
    const r = this.retry;

    if (status === 429 && retryAfter !== undefined) {
      return Math.min(retryAfter, r.max_delay);
    }

    if (status === 504) {
      const base = r.retry_504_delay;
      const exponential = base * Math.pow(2, attempt - 1);
      const jitter = Math.random() * r.jitter * base;
      return Math.min(exponential + jitter, r.max_delay);
    }

    const exponential = r.base_delay * Math.pow(2, attempt - 1);
    const jitter = Math.random() * r.jitter * r.base_delay;
    return Math.min(exponential + jitter, r.max_delay);
  }

  private async doRequest(
    messages: ChatMessage[],
    options?: { jsonMode?: boolean; maxTokens?: number; timeout?: number },
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      max_tokens: options?.maxTokens ?? this.maxTokens,
    };

    if (options?.jsonMode) {
      payload.response_format = { type: "json_object" };
    }

    const requestTimeout = options?.timeout ?? this.timeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof Error && e.name === "AbortError") {
        throw new LLMNetworkError(`LLM request timed out after ${requestTimeout / 1000}s`, e);
      }
      throw new LLMNetworkError(
        `LLM request failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
    clearTimeout(timer);

    if (!response.ok) {
      let errBody = "";
      try {
        errBody = await response.text();
      } catch { /* ignore */ }

      if (response.status === 400 && options?.jsonMode && errBody.includes("response_format")) {
        return this.doRequest(messages, { ...options, jsonMode: false });
      }

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      throw new LLMHttpError(
        `LLM HTTP ${response.status}: ${errBody.slice(0, 500)}`,
        response.status,
        retryAfter,
      );
    }

    let data: any;
    try {
      data = await response.json();
    } catch (e) {
      throw new LLMError(
        `LLM response JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }

    try {
      const content = data.choices[0].message.content;
      return (content || "").trim();
    } catch (e) {
      throw new LLMError(
        `LLM response structure unexpected: ${JSON.stringify(data).slice(0, 200)}`,
        e,
      );
    }
  }

  async chat(
    messages: ChatMessage[],
    options?: { jsonMode?: boolean; maxTokens?: number; timeout?: number },
  ): Promise<string> {
    const r = this.retry;
    let httpRetries = 0;
    let emptyRetries = 0;

    while (true) {
      try {
        const result = await this.doRequest(messages, options);

        if (!result) {
          if (emptyRetries < r.empty_retries) {
            emptyRetries++;
            const delay = r.empty_retry_delay * (1 + Math.random() * r.jitter);
            log("WARN", "llm", "empty response, retrying", { attempt: `${emptyRetries}/${r.empty_retries}`, delay: `${delay.toFixed(1)}s` });
            await sleep(delay * 1000);
            continue;
          }
          throw new LLMError("LLM returned empty response after retries");
        }

        return result;
      } catch (e) {
        if (e instanceof LLMHttpError) {
          const retryable = r.retry_on_status.includes(e.status);
          if (retryable && httpRetries < r.max_retries) {
            httpRetries++;
            const delay = this.calcDelay(e.status, e.retryAfter, httpRetries);
            log("WARN", "llm", "HTTP error, retrying", { status: e.status, attempt: `${httpRetries}/${r.max_retries}`, delay: `${delay.toFixed(1)}s` });
            await sleep(delay * 1000);
            continue;
          }
          throw e;
        }

        if (e instanceof LLMNetworkError) {
          if (httpRetries < r.max_retries) {
            httpRetries++;
            const delay = this.calcDelay(undefined, undefined, httpRetries);
            log("WARN", "llm", "network error, retrying", { error: e.message, attempt: `${httpRetries}/${r.max_retries}`, delay: `${delay.toFixed(1)}s` });
            await sleep(delay * 1000);
            continue;
          }
          throw e;
        }

        throw e;
      }
    }
  }

  async visionChat(
    prompt: string,
    imageBase64: string,
    mimeType = "image/jpeg",
    options?: { jsonMode?: boolean; maxTokens?: number; timeout?: number },
  ): Promise<string> {
    const messages: ChatMessage[] = [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
      ],
    }];
    return this.chat(messages, options);
  }

  async visionChatMultiImage(
    prompt: string,
    images: { base64: string; mimeType?: string }[],
    options?: { jsonMode?: boolean; maxTokens?: number; timeout?: number },
  ): Promise<string> {
    const parts: ContentPart[] = [{ type: "text", text: prompt }];
    for (const img of images) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${img.mimeType || "image/jpeg"};base64,${img.base64}` },
      });
    }
    const messages: ChatMessage[] = [{ role: "user", content: parts }];
    return this.chat(messages, options);
  }
}
