#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";
import { log, getLogInfo, initLogger } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  initLogger({ maxFileSize: config.logging.max_file_size, maxFiles: config.logging.max_files });
  const server = new McpServer({
    name: "my-own-vision-mcp",
    version: "0.1.1",
  });
  registerTools(server, config);
  registerPrompts(server, config);
  try {
    await import("sharp");
    log("INFO", "server", "sharp available (image resize/compress enabled)");
  } catch {
    log("WARN", "server", "sharp NOT available (images sent raw — install sharp: npm install sharp)");
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const { client, logFile } = getLogInfo();
  log("INFO", "server", "started", { provider: config.llm.default_provider, model: config.llm.providers[config.llm.default_provider]?.model, max_tokens: config.llm.providers[config.llm.default_provider]?.max_tokens, client, logFile });
}

main().catch((e) => {
  log("ERROR", "server", "fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
