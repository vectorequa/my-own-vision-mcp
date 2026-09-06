import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";

function textMsg(text: string): { messages: [{ role: "user"; content: { type: "text"; text: string } }] } {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

export function registerPrompts(server: McpServer, _config: AppConfig): void {
  server.prompt(
    "ocr",
    "Extract all text from an image (OCR), preserving layout",
    { image: z.string().describe("图片路径、base64 或 URL") },
    async ({ image }) => textMsg(
      `Use the extract_text tool to perform OCR on this image (extract all text, preserving original layout and line breaks):\n\n${image}`
    ),
  );

  server.prompt(
    "describe",
    "Analyze/describe an image, optionally with a focus",
    {
      image: z.string().describe("图片路径、base64 或 URL"),
      focus: z.string().optional().describe("可选：想让分析关注的方面")
    },
    async ({ image, focus }) => textMsg(
      `Use the analyze_image tool to analyze this image:\n\n${image}${focus ? `\n\nFocus on: ${focus}` : ""}`
    ),
  );

  server.prompt(
    "compare",
    "Compare two images and describe similarities and differences",
    {
      image1: z.string().describe("第一张图片路径、base64 或 URL"),
      image2: z.string().describe("第二张图片路径、base64 或 URL"),
      focus: z.string().optional().describe("可选：想让对比关注的方面")
    },
    async ({ image1, image2, focus }) => textMsg(
      `Use the compare_images tool to compare these two images and describe their similarities and differences:\n\nImage 1: ${image1}\nImage 2: ${image2}${focus ? `\n\nFocus on: ${focus}` : ""}`
    ),
  );

  server.prompt(
    "ui-tree",
    "Extract UI accessibility tree from a screenshot and suggest actions",
    {
      image: z.string().describe("GUI 截图路径或 URL"),
      format: z.enum(["axtree", "json"]).optional().describe("输出格式，默认 axtree")
    },
    async ({ image, format }) => textMsg(
      `You are given a GUI screenshot. Perform the following workflow:

1. Call the analyze_screenshot tool on this image to extract the UI accessibility tree:
   ${image}
   ${format ? `Use format: ${format}` : "Use the default axtree format."}

2. From the returned tree, identify and list the interactive elements (buttons, links, input fields, menus, checkboxes, etc.) with their ref identifiers.

3. Summarize the overall page/window structure: what kind of UI this is (web page / desktop app / mobile app), what the main regions are, and its likely purpose.

4. Suggest actionable next steps: which elements a user or agent could interact with, what form fields need input, and what navigation is available.

Present the results clearly with these sections:
(1) Raw Tree
(2) Interactive Elements
(3) Structure Summary
(4) Suggested Actions`
    ),
  );

  log("INFO", "server", "prompts registered", { count: 4 });
}
