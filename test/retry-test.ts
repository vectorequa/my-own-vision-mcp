import { createServer, type Server } from "node:http";
import { LLMClient, LLMHttpError } from "../src/llm-client.js";
import type { ProviderConfig } from "../src/config.js";

interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  empty?: boolean;
}

async function withMockServer(
  responses: MockResponse[],
  fn: (port: number) => Promise<void>,
): Promise<void> {
  let callIndex = 0;
  const server: Server = createServer((req, res) => {
    const mock = responses[Math.min(callIndex, responses.length - 1)];
    callIndex++;
    const status = mock.status ?? 200;
    const headers = mock.headers ?? {};
    if (mock.empty) {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify({ choices: [{ message: { content: "" } }] }));
    } else if (mock.body !== undefined) {
      res.writeHead(status, { "Content-Type": "text/plain", ...headers });
      res.end(mock.body);
    } else {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

function makeProvider(port: number, overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    url: `http://127.0.0.1:${port}/v1`,
    api_key: "test-key",
    model: "test-model",
    max_tokens: 100,
    timeout: 5,
    retry: {
      max_retries: 3,
      base_delay: 0.01,
      max_delay: 0.1,
      jitter: 0.5,
      retry_on_status: [429, 500, 502, 503, 504],
      retry_504_delay: 0.05,
      empty_retries: 3,
      empty_retry_delay: 0.01,
    },
    ...overrides,
  };
}

async function test429ThenSuccess(): Promise<void> {
  console.log("  test: 429 → 200 ...");
  await withMockServer([{ status: 429, headers: { "retry-after": "1" } }, {}], async (port) => {
    const provider = makeProvider(port);
    const client = new LLMClient(provider);
    const result = await client.chat([{ role: "user", content: "hi" }]);
    if (result !== "ok") throw new Error(`expected "ok", got "${result}"`);
  });
  console.log("  passed ✓");
}

async function test503ThenSuccess(): Promise<void> {
  console.log("  test: 503 → 200 ...");
  await withMockServer([{ status: 503 }, {}], async (port) => {
    const client = new LLMClient(makeProvider(port));
    const result = await client.chat([{ role: "user", content: "hi" }]);
    if (result !== "ok") throw new Error(`expected "ok", got "${result}"`);
  });
  console.log("  passed ✓");
}

async function testEmptyThenSuccess(): Promise<void> {
  console.log("  test: empty → 200 ...");
  await withMockServer([{ empty: true }, {}], async (port) => {
    const client = new LLMClient(makeProvider(port));
    const result = await client.chat([{ role: "user", content: "hi" }]);
    if (result !== "ok") throw new Error(`expected "ok", got "${result}"`);
  });
  console.log("  passed ✓");
}

async function test429RetryAfterHeader(): Promise<void> {
  console.log("  test: 429 Retry-After=2 → 200 (delay capped by max_delay) ...");
  await withMockServer([{ status: 429, headers: { "retry-after": "2" } }, {}], async (port) => {
    const client = new LLMClient(makeProvider(port));
    const t0 = Date.now();
    const result = await client.chat([{ role: "user", content: "hi" }]);
    const elapsed = (Date.now() - t0) / 1000;
    if (result !== "ok") throw new Error(`expected "ok", got "${result}"`);
    if (elapsed > 1.0) throw new Error(`delay should be capped at max_delay=0.1s, took ${elapsed.toFixed(2)}s`);
  });
  console.log("  passed ✓");
}

async function testMaxRetriesExhausted(): Promise<void> {
  console.log("  test: 503 ×4 → throw (max_retries=3) ...");
  await withMockServer([
    { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 },
  ], async (port) => {
    const client = new LLMClient(makeProvider(port));
    try {
      await client.chat([{ role: "user", content: "hi" }]);
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof LLMHttpError)) throw new Error(`expected LLMHttpError, got ${e instanceof Error ? e.constructor.name : typeof e}`);
      if (e.status !== 503) throw new Error(`expected status 503, got ${e.status}`);
    }
  });
  console.log("  passed ✓");
}

async function testNonRetryable400(): Promise<void> {
  console.log("  test: 400 → throw immediately (no retry) ...");
  await withMockServer([{ status: 400, body: "bad request" }], async (port) => {
    const client = new LLMClient(makeProvider(port));
    try {
      await client.chat([{ role: "user", content: "hi" }]);
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof LLMHttpError)) throw new Error(`expected LLMHttpError, got ${e instanceof Error ? e.constructor.name : typeof e}`);
      if (e.status !== 400) throw new Error(`expected status 400, got ${e.status}`);
    }
  });
  console.log("  passed ✓");
}

async function testEmptyRetriesExhausted(): Promise<void> {
  console.log("  test: empty ×4 → throw (empty_retries=3) ...");
  await withMockServer([
    { empty: true }, { empty: true }, { empty: true }, { empty: true },
  ], async (port) => {
    const client = new LLMClient(makeProvider(port));
    try {
      await client.chat([{ role: "user", content: "hi" }]);
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof Error)) throw new Error(`expected Error, got ${typeof e}`);
      if (!e.message.includes("empty")) throw new Error(`expected "empty" in message, got "${e.message}"`);
    }
  });
  console.log("  passed ✓");
}

async function test504SpecialDelay(): Promise<void> {
  console.log("  test: 504 → 200 (uses retry_504_delay) ...");
  await withMockServer([{ status: 504 }, {}], async (port) => {
    const client = new LLMClient(makeProvider(port));
    const result = await client.chat([{ role: "user", content: "hi" }]);
    if (result !== "ok") throw new Error(`expected "ok", got "${result}"`);
  });
  console.log("  passed ✓");
}

async function testMultipleErrorsThenSuccess(): Promise<void> {
  console.log("  test: 429 → 503 → empty → 200 ...");
  await withMockServer([
    { status: 429, headers: { "retry-after": "0" } },
    { status: 503 },
    { empty: true },
    {},
  ], async (port) => {
    const client = new LLMClient(makeProvider(port));
    const result = await client.chat([{ role: "user", content: "hi" }]);
    if (result !== "ok") throw new Error(`expected "ok", got "${result}"`);
  });
  console.log("  passed ✓");
}

async function main(): Promise<void> {
  console.log("retry tests:");
  await test429ThenSuccess();
  await test503ThenSuccess();
  await testEmptyThenSuccess();
  await test429RetryAfterHeader();
  await testMaxRetriesExhausted();
  await testNonRetryable400();
  await testEmptyRetriesExhausted();
  await test504SpecialDelay();
  await testMultipleErrorsThenSuccess();
  console.log("\nall retry tests passed ✓");
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
