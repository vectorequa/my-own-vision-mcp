#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OPENROUTER_API = "https://openrouter.ai/api/v1";
const USER_CONFIG_PATH = join(homedir(), ".config", "my-own-vision-mcp", "my-own-vision-mcp.json");
const TEST_TIMEOUT_MS = 30000;
const DEFAULT_CONCURRENCY = 3;
const RATE_LIMIT_DELAY_MS = 1000;

interface OrModel {
  id: string;
  name: string;
  architecture: {
    modality: string;
    input_modalities: string[];
    output_modalities: string[];
  };
  pricing: { prompt: string; completion: string };
  context_length: number;
  top_provider?: { max_completion_tokens?: number };
  supported_parameters: string[];
}

interface TestResult {
  model: string;
  status: "ok" | "fail";
  latencyMs: number;
  response?: string;
  error?: string;
}

interface ExistingProvider {
  name: string;
  model: string;
  enable: boolean;
  api_key?: string;
}

function parseArgs(): { testExisting: boolean; concurrency: number; skipTest: boolean; wLatency: number; wSize: number } {
  const args = process.argv.slice(2);
  const wLatency = parseFloat(args.find((a) => a.startsWith("--w-latency="))?.split("=")[1] || "") || 0.3;
  const wSize = parseFloat(args.find((a) => a.startsWith("--w-size="))?.split("=")[1] || "") || 0.7;
  return {
    testExisting: args.includes("--test-existing"),
    concurrency: parseInt(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] || "") || DEFAULT_CONCURRENCY,
    skipTest: args.includes("--skip-test"),
    wLatency,
    wSize,
  };
}

function estimateModelSizeB(model: OrModel): number {
  const text = `${model.id} ${model.name}`.toLowerCase();
  const bMatch = text.match(/(\d+(?:\.\d+)?)b\b/);
  if (bMatch) return parseFloat(bMatch[1]);
  if (text.includes("nano") || text.includes("tiny")) return 1;
  if (text.includes("mini") || text.includes("flash")) return 3;
  if (text.includes("small")) return 8;
  if (text.includes("pro") || text.includes("max") || text.includes("large")) return 35;
  const ctx = model.context_length || 0;
  if (ctx > 0 && ctx <= 200000) return 7;
  if (ctx <= 500000) return 20;
  return 40;
}

interface ModelScore {
  modelId: string;
  latencyMs: number;
  sizeB: number;
  score: number;
  normLatency: number;
  normSize: number;
}

function computeScores(
  results: TestResult[],
  models: OrModel[],
  wLatency: number,
  wSize: number,
): ModelScore[] {
  const ok = results.filter((r) => r.status === "ok");
  if (ok.length === 0) return [];
  const latencies = ok.map((r) => r.latencyMs);
  const sizes = ok.map((r) => {
    const m = models.find((m) => m.id === r.model)!;
    return estimateModelSizeB(m);
  });
  const minLat = Math.min(...latencies);
  const maxLat = Math.max(...latencies);
  const minSize = Math.min(...sizes);
  const maxSize = Math.max(...sizes);
  const wSum = wLatency + wSize || 1;

  return ok.map((r) => {
    const m = models.find((m) => m.id === r.model)!;
    const sizeB = estimateModelSizeB(m);
    const normLatency = maxLat > minLat ? (r.latencyMs - minLat) / (maxLat - minLat) : 0;
    const normSize = maxSize > minSize ? (maxSize - sizeB) / (maxSize - minSize) : 0;
    const score = (wLatency * normLatency + wSize * normSize) / wSum;
    return { modelId: r.model, latencyMs: r.latencyMs, sizeB, score, normLatency, normSize };
  }).sort((a, b) => a.score - b.score);
}

function loadUserConfig(): any {
  if (!existsSync(USER_CONFIG_PATH)) {
    console.error("User config not found:", USER_CONFIG_PATH);
    process.exit(1);
  }
  return JSON.parse(readFileSync(USER_CONFIG_PATH, "utf-8"));
}

function findOpenRouterApiKey(userConfig: any): { key: string; provider: string } {
  for (const [name, p] of Object.entries(userConfig.llm.providers)) {
    const provider = p as any;
    if (provider.url?.includes("openrouter") && provider.api_key && provider.api_key !== "<YOUR_OPENROUTER_KEY>") {
      return { key: provider.api_key, provider: name };
    }
  }
  console.error("No OpenRouter API key found in any provider config");
  console.error("Set api_key in a provider with url containing 'openrouter' in:", USER_CONFIG_PATH);
  process.exit(1);
}

function getExistingProviders(userConfig: any): ExistingProvider[] {
  const result: ExistingProvider[] = [];
  for (const [name, p] of Object.entries(userConfig.llm.providers)) {
    const provider = p as any;
    if (provider.url?.includes("openrouter")) {
      result.push({
        name,
        model: provider.model,
        enable: provider.enable !== false,
        api_key: provider.api_key,
      });
    }
  }
  return result;
}

async function fetchFreeVisionModels(): Promise<OrModel[]> {
  console.log("Fetching OpenRouter model list...");
  const resp = await fetch(`${OPENROUTER_API}/models`);
  if (!resp.ok) throw new Error(`Failed to fetch models: HTTP ${resp.status}`);
  const data = await resp.json() as { data: OrModel[] };

  const freeVision = data.data.filter(
    (m) =>
      m.architecture?.input_modalities?.includes("image") &&
      m.pricing?.prompt === "0",
  );

  console.log(`Found ${freeVision.length} free vision models (out of ${data.data.length} total)`);
  return freeVision;
}

async function generateTestImage(): Promise<string> {
  try {
    const sharp = (await import("sharp")).default;
    const svg = `<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect width="400" height="300" fill="white"/>
  <text x="20" y="40" font-family="monospace" font-size="24" fill="black">Hello World 12345</text>
  <rect x="20" y="60" width="120" height="60" fill="blue"/>
  <text x="150" y="95" font-family="monospace" font-size="16" fill="white">BLUE</text>
  <rect x="160" y="60" width="80" height="60" fill="red"/>
  <text x="180" y="95" font-family="monospace" font-size="14" fill="white">RED</text>
  <text x="20" y="160" font-family="monospace" font-size="16" fill="black">Vision Test 2026</text>
  <line x1="20" y1="180" x2="380" y2="180" stroke="green" stroke-width="2"/>
  <text x="20" y="210" font-family="monospace" font-size="14" fill="#333">OCR: ABC-123-XYZ</text>
  <text x="20" y="240" font-family="monospace" font-size="14" fill="#333">Count: 2 rectangles, 1 line</text>
</svg>`;
    const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
    return buf.toString("base64");
  } catch {
    const svg = `<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect width="400" height="300" fill="white"/>
  <text x="20" y="40" font-family="monospace" font-size="24" fill="black">Hello World 12345</text>
</svg>`;
    return Buffer.from(svg).toString("base64");
  }
}

async function testModel(
  modelId: string,
  apiKey: string,
  testImageBase64: string,
): Promise<TestResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);

  try {
    const resp = await fetch(`${OPENROUTER_API}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe this image briefly. What text do you see? What shapes and colors?" },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${testImageBase64}` } },
          ],
        }],
        stream: false,
        max_tokens: 256,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const ms = Date.now() - t0;

    if (!resp.ok) {
      const body = await resp.text();
      return { model: modelId, status: "fail", latencyMs: ms, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || "";
    return { model: modelId, status: "ok", latencyMs: ms, response: content.slice(0, 200) };
  } catch (e: any) {
    clearTimeout(timer);
    return {
      model: modelId,
      status: "fail",
      latencyMs: Date.now() - t0,
      error: e.name === "AbortError" ? "TIMEOUT" : e.message,
    };
  }
}

async function testModelsConcurrent(
  models: OrModel[],
  apiKey: string,
  testImage: string,
  concurrency: number,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  let index = 0;
  let completed = 0;
  const total = models.length;

  async function worker(): Promise<void> {
    while (index < models.length) {
      const i = index++;
      const m = models[i];
      process.stdout.write(`  [${completed + 1}/${total}] Testing ${m.id}...`);
      const r = await testModel(m.id, apiKey, testImage);
      results[i] = r;
      completed++;
      const status = r.status === "ok" ? `OK (${r.latencyMs}ms)` : `FAIL: ${r.error?.slice(0, 60)}`;
      console.log(` ${status}`);
      if (r.status === "ok" && r.response) {
        console.log(`    Response: ${r.response.slice(0, 120)}...`);
      }
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, models.length) }, () => worker()));
  return results;
}

function generateConfigSkeleton(model: OrModel, testResult: TestResult): string {
  const supportsJson = model.supported_parameters?.includes("response_format");
  const maxTokens = model.top_provider?.max_completion_tokens || 8192;
  const providerName = `openrouter-${model.id.split("/").pop()?.replace(/:free$/, "").replace(/[^a-z0-9-]/gi, "-")}`;

  const status = testResult.status === "ok" ? "ACTIVE" : "UNTESTED";
  const notes = testResult.status === "ok"
    ? `[${status}] ${model.name}. 视觉模型, 待人工评估强项. 延迟 ${testResult.latencyMs}ms.${supportsJson ? " 支持 JSON mode." : ""}`
    : `[${status}] ${model.name}. 测试失败: ${testResult.error}. 保留参考.`;

  return `      "${providerName}": {
        "enable": true,
        "url": "https://openrouter.ai/api/v1",
        "api_key": "<YOUR_OPENROUTER_KEY>",
        "model": "${model.id}",
        "extra_notes": "${notes}",
        "max_tokens": 8192,
        "timeout": 60,
        "retry": { "max_retries": 2, "max_504_retries": 1, "retry_504_delay": 5.0 },
        "capabilities": {
          "max_image_dim": 2048,
          "jpeg_quality": 85,
          "best_for": [],
          "supports_json_mode": ${supportsJson},
          "supports_multi_image": true,
          "rate_limit_tier": "low"
        }
      }`;
}

function printTable(models: OrModel[], existingMap: Map<string, ExistingProvider>): void {
  console.log("\n=== Free Vision Models on OpenRouter ===");
  console.log("Model ID".padEnd(55), "JSON".padEnd(6), "Ctx".padEnd(8), "Status");
  console.log("-".repeat(85));
  for (const m of models) {
    const json = m.supported_parameters?.includes("response_format") ? "yes" : "no";
    const existing = existingMap.get(m.id);
    let marker: string;
    if (!existing) {
      marker = "NEW";
    } else if (existing.enable) {
      marker = "enabled";
    } else {
      marker = "disabled";
    }
    console.log(m.id.padEnd(55), json.padEnd(6), (m.context_length?.toString() || "?").padEnd(8), marker);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const userConfig = loadUserConfig();
  const { key: apiKey, provider: apiKeyProvider } = findOpenRouterApiKey(userConfig);
  console.log(`Using API key from provider: ${apiKeyProvider}`);

  const existingProviders = getExistingProviders(userConfig);
  const existingMap = new Map<string, ExistingProvider>();
  for (const p of existingProviders) {
    existingMap.set(p.model, p);
  }

  const apiModels = await fetchFreeVisionModels();
  const apiModelIds = new Set(apiModels.map((m) => m.id));

  const newModels = apiModels.filter((m) => !existingMap.has(m.id));
  const removedModels = existingProviders.filter((p) => !apiModelIds.has(p.model));
  const existingInApi = apiModels.filter((m) => existingMap.has(m.id));

  printTable(apiModels, existingMap);

  const enabledCount = existingProviders.filter((p) => p.enable).length;
  const disabledCount = existingProviders.filter((p) => !p.enable).length;
  console.log(`\n=== Summary ===`);
  console.log(`In config: ${existingProviders.length} (${enabledCount} enabled, ${disabledCount} disabled), In API: ${apiModels.length}`);
  console.log(`New (in API, not in config): ${newModels.length}`);
  console.log(`Removed (in config, not in API): ${removedModels.length}`);

  if (removedModels.length > 0) {
    console.log("\n=== Removed Models (in config but not in API) ===");
    for (const p of removedModels) {
      const tag = p.enable ? "" : " [disabled]";
      console.log(`  ${p.model} (config: ${p.name})${tag}`);
    }
  }

  if (existingInApi.length > 0) {
    console.log("\n=== Existing Models Status ===");
    for (const m of existingInApi) {
      const p = existingMap.get(m.id)!;
      const tag = p.enable ? "enabled" : "disabled";
      console.log(`  ${m.id} → ${p.name} [${tag}]`);
    }
  }

  const allTestResults: Record<string, TestResult> = {};
  let newResults: TestResult[] = [];

  if (!opts.skipTest && newModels.length > 0) {
    console.log(`\n=== Testing ${newModels.length} New Models (concurrency=${opts.concurrency}) ===`);
    const testImage = await generateTestImage();
    newResults = await testModelsConcurrent(newModels, apiKey, testImage, opts.concurrency);
    for (let i = 0; i < newModels.length; i++) {
      allTestResults[newModels[i].id] = newResults[i];
    }
  }

  if (!opts.skipTest && opts.testExisting && existingInApi.length > 0) {
    console.log(`\n=== Testing ${existingInApi.length} Existing Models (concurrency=${opts.concurrency}) ===`);
    const testImage = await generateTestImage();
    const existingResults = await testModelsConcurrent(existingInApi, apiKey, testImage, opts.concurrency);
    for (let i = 0; i < existingInApi.length; i++) {
      allTestResults[existingInApi[i].id] = existingResults[i];
    }

    const broken = existingResults.filter((r) => r.status === "fail");
    if (broken.length > 0) {
      console.log("\n=== WARNING: Broken Existing Models ===");
      for (const r of broken) {
        const p = existingMap.get(r.model);
        console.log(`  ${r.model} (${p?.name}): ${r.error?.slice(0, 80)}`);
        console.log(`    → Consider setting "enable": false for this provider`);
      }
    }
  }

  if (newModels.length > 0 && newResults.length > 0) {
    console.log("\n=== Config Skeleton for New Models ===");
    console.log("(Add these to ~/.config/my-own-vision-mcp/my-own-vision-mcp.json > llm.providers)\n");
    for (let i = 0; i < newModels.length; i++) {
      const skeleton = generateConfigSkeleton(newModels[i], newResults[i]);
      console.log(skeleton);
      if (i < newModels.length - 1) console.log(",");
    }

    const working = newResults.filter((r) => r.status === "ok");
    if (working.length > 0) {
      const scores = computeScores(newResults, newModels, opts.wLatency, opts.wSize);
      console.log(`\n=== New Models Ranked by Score (w_latency=${opts.wLatency}, w_size=${opts.wSize}) ===`);
      console.log("  Score   Latency   Size    Model");
      console.log("  " + "-".repeat(75));
      for (const s of scores) {
        const m = newModels.find((m) => m.id === s.modelId)!;
        const json = m.supported_parameters?.includes("response_format") ? "+JSON" : "";
        console.log(`  ${s.score.toFixed(3)}   ${String(s.latencyMs).padStart(5)}ms  ${String(s.sizeB).padStart(3)}B   ${s.modelId} ${json}`);
      }
      const best = scores[0];
      console.log(`\nRecommendation: ${best.modelId} (score=${best.score.toFixed(3)}, ${best.latencyMs}ms, ~${best.sizeB}B)`);
      console.log(`  Lower score = better. Size prefers larger (more capable). Adjust: --w-latency=N --w-size=N`);
    }
  }

  const allTestedModels = apiModels.filter((m) => allTestResults[m.id]?.status === "ok");
  if (allTestedModels.length > 0) {
    const allOkResults = allTestedModels.map((m) => allTestResults[m.id]);
    const allScores = computeScores(allOkResults, allTestedModels, opts.wLatency, opts.wSize);
    console.log(`\n=== All Working Models Ranked by Score (w_latency=${opts.wLatency}, w_size=${opts.wSize}) ===`);
    console.log("  Rank  Score   Latency   Size    Model");
    console.log("  " + "-".repeat(80));
    for (let i = 0; i < allScores.length; i++) {
      const s = allScores[i];
      const m = allTestedModels.find((m) => m.id === s.modelId)!;
      const json = m.supported_parameters?.includes("response_format") ? "+JSON" : "";
      const existing = existingMap.get(s.modelId);
      const tag = existing ? (existing.enable ? "" : " [disabled]") : " [NEW]";
      console.log(`  ${String(i + 1).padStart(2)}.   ${s.score.toFixed(3)}   ${String(s.latencyMs).padStart(5)}ms  ${String(s.sizeB).padStart(3)}B   ${s.modelId} ${json}${tag}`);
    }
    const best = allScores[0];
    console.log(`\nRecommendation: ${best.modelId} (score=${best.score.toFixed(3)}, ${best.latencyMs}ms, ~${best.sizeB}B)`);
    console.log(`  Lower score = better. Size prefers larger (more capable). Adjust: --w-latency=N --w-size=N`);
  }

  const reportPath = join(homedir(), ".config", "my-own-vision-mcp", "discover-report.json");
  const report = {
    timestamp: new Date().toISOString(),
    apiKeyProvider,
    apiTotal: apiModels.length,
    configTotal: existingProviders.length,
    configEnabled: enabledCount,
    configDisabled: disabledCount,
    newModels: newModels.map((m) => ({
      id: m.id,
      name: m.name,
      modality: m.architecture.modality,
      context_length: m.context_length,
      supports_json: m.supported_parameters?.includes("response_format"),
      estimated_size_b: estimateModelSizeB(m),
      test: allTestResults[m.id] || null,
    })),
    removedModels: removedModels.map((p) => ({ id: p.model, configName: p.name, enabled: p.enable })),
    existingModels: existingInApi.map((m) => ({
      id: m.id,
      configName: existingMap.get(m.id)!.name,
      enabled: existingMap.get(m.id)!.enable,
      test: allTestResults[m.id] || null,
    })),
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to: ${reportPath}`);
}

main().catch((e) => {
  console.error("Fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
