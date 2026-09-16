import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";

type GetConfig = () => AppConfig;

function textMsg(text: string): { messages: [{ role: "user"; content: { type: "text"; text: string } }] } {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

export function registerPrompts(server: McpServer, _getConfig: GetConfig): void {
  server.prompt(
    "ocr",
    "Extract all text from an image (OCR), preserving layout.",
    { image: z.string().describe("Image path, base64, or URL") },
    async ({ image }) => textMsg(
      `Use the extract_text tool to perform OCR on this image:\n\n${image}`
    ),
  );

  server.prompt(
    "describe",
    "Analyze/describe an image, optionally with a focus.",
    {
      image: z.string().describe("Image path, base64, or URL"),
      focus: z.string().optional().describe("Optional: aspect to focus the analysis on")
    },
    async ({ image, focus }) => textMsg(
      `Use the analyze_image tool to analyze this image:\n\n${image}${focus ? `\n\nUse prompt: "${focus}"` : ""}`
    ),
  );

  server.prompt(
    "compare",
    "Compare two images and describe similarities and differences.",
    {
      image1: z.string().describe("First image path, base64, or URL"),
      image2: z.string().describe("Second image path, base64, or URL"),
      focus: z.string().optional().describe("Optional: aspect to focus the comparison on")
    },
    async ({ image1, image2, focus }) => textMsg(
      `Use the analyze_image tool to compare these two images:\n\nPass image as an array: ["${image1}", "${image2}"]${focus ? `\n\nUse prompt: "Compare these two images. Focus on: ${focus}"` : ""}`
    ),
  );

  log("INFO", "server", "prompts registered", { count: 3 });
}
