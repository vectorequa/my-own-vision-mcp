#!/usr/bin/env node

import { watchFile, unwatchFile, Stats } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, getConfigPaths } from "./config.js";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";
import { log, getLogInfo, initLogger } from "./logger.js";

async function main(): Promise<void> {
  let config = loadConfig();
  initLogger({ maxFileSize: config.logging.max_file_size, maxFiles: config.logging.max_files });

  const getConfig = () => config;

  const server = new McpServer({
    name: "my-own-vision-mcp",
    version: "0.1.4",
  });
  registerTools(server, getConfig);
  registerPrompts(server, getConfig);

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

  const watchers: string[] = [];
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  function reloadConfig(): void {
    try {
      const newConfig = loadConfig();
      config = newConfig;
      initLogger({ maxFileSize: config.logging.max_file_size, maxFiles: config.logging.max_files });
      log("INFO", "config", "hot reloaded", { provider: config.llm.default_provider, model: config.llm.providers[config.llm.default_provider]?.model });
    } catch (e) {
      log("ERROR", "config", "hot reload failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  function onConfigChange(): void {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reloadConfig, 300);
  }

  const paths = getConfigPaths();
  const watchOpts = { interval: 2000, persistent: true };
  try {
    watchFile(paths.project, watchOpts, (curr: Stats, prev: Stats) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        log("DEBUG", "config", "file changed", { file: paths.project, mtime: curr.mtime.toISOString() });
        onConfigChange();
      }
    });
    watchers.push(paths.project);
    log("INFO", "config", "watching", { file: paths.project });
  } catch (e) {
    log("WARN", "config", "watch failed", { file: paths.project, error: e instanceof Error ? e.message : String(e) });
  }
  if (paths.user) {
    try {
      watchFile(paths.user, watchOpts, (curr: Stats, prev: Stats) => {
        if (curr.mtimeMs !== prev.mtimeMs) {
          log("DEBUG", "config", "file changed", { file: paths.user, mtime: curr.mtime.toISOString() });
          onConfigChange();
        }
      });
      watchers.push(paths.user);
      log("INFO", "config", "watching", { file: paths.user });
    } catch (e) {
      log("WARN", "config", "watch failed", { file: paths.user, error: e instanceof Error ? e.message : String(e) });
    }
  }

  process.on("SIGINT", () => {
    watchers.forEach((f) => unwatchFile(f));
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    watchers.forEach((f) => unwatchFile(f));
    process.exit(0);
  });
}

main().catch((e) => {
  log("ERROR", "server", "fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
