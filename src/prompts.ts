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
    "Extract all text from an image (OCR), preserving layout. Pass detail='high' for small/dense text.",
    { image: z.string().describe("Image path, base64, or URL") },
    async ({ image }) => textMsg(
      `Use the extract_text tool to perform OCR on this image (extract all text, preserving original layout and line breaks):\n\n${image}\n\nFor small or dense text, pass detail='high' for better recognition. If the image is large, detail='high' may timeout — start with detail='auto' and increase if needed.`
    ),
  );

  server.prompt(
    "describe",
    "Analyze/describe an image, optionally with a focus. Use detail='low' for quick overview, 'high' for detail.",
    {
      image: z.string().describe("Image path, base64, or URL"),
      focus: z.string().optional().describe("Optional: aspect to focus the analysis on")
    },
    async ({ image, focus }) => textMsg(
      `Use the analyze_image tool to analyze this image:\n\n${image}${focus ? `\n\nFocus on: ${focus}` : ""}\n\nUse detail='low' for a quick overview, 'medium' for balanced description (default), or 'high' for detail-sensitive analysis. Higher resolution is slower and may timeout on large images.`
    ),
  );

  server.prompt(
    "compare",
    "Compare two images and describe similarities and differences. Use detail='low' or 'medium' for most cases.",
    {
      image1: z.string().describe("First image path, base64, or URL"),
      image2: z.string().describe("Second image path, base64, or URL"),
      focus: z.string().optional().describe("Optional: aspect to focus the comparison on")
    },
    async ({ image1, image2, focus }) => textMsg(
      `Use the compare_images tool to compare these two images and describe their similarities and differences:\n\nImage 1: ${image1}\nImage 2: ${image2}${focus ? `\n\nFocus on: ${focus}` : ""}\n\nUse detail='low' or 'medium' for most comparisons. Use 'high' only if you need to compare fine details.`
    ),
  );

  server.prompt(
    "ui-tree",
    "Extract UI accessibility tree from a screenshot and suggest actions. Set max_elements to prevent token overflow.",
    {
      image: z.string().describe("GUI screenshot path or URL"),
      format: z.enum(["axtree", "json"]).optional().describe("Output format, default axtree")
    },
    async ({ image, format }) => textMsg(
      `You are given a GUI screenshot. Perform the following workflow:

1. Call the analyze_screenshot tool on this image to extract the UI accessibility tree:
   ${image}
   ${format ? `Use format: ${format}` : "Use the default axtree format."}
   If the screenshot has many elements, set max_elements to prevent output truncation.

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
