import { log } from "./logger.js";

export function safeJsonParse(text: string): Record<string, unknown> | unknown[] | null {
  if (!text || !text.trim()) return null;

  const tryObj = (s: string): Record<string, unknown> | unknown[] | null => {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === "object") return obj;
    } catch { /* continue */ }
    return null;
  };

  let r: Record<string, unknown> | unknown[] | null;

  if ((r = tryObj(text)) !== null) return r;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch && (r = tryObj(jsonMatch[0])) !== null) return r;

  const stripped = text.trim();
  if (stripped.startsWith("```")) {
    const lines = stripped.split("\n");
    if (lines[0].startsWith("```")) lines.shift();
    if (lines.length > 0 && lines[lines.length - 1].startsWith("```")) lines.pop();
    const cleaned = lines.join("\n");
    if ((r = tryObj(cleaned)) !== null) return r;
    const m2 = cleaned.match(/\{[\s\S]*\}/);
    if (m2 && (r = tryObj(m2[0])) !== null) return r;
  }

  if ((r = tryObj(text.replace(/'/g, '"'))) !== null) return r;

  if ((r = tryObj(text.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]"))) !== null) return r;

  const fixed = text.replace(/'/g, '"').replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
  const m3 = fixed.match(/\{[\s\S]*\}/);
  if (m3 && (r = tryObj(m3[0])) !== null) return r;

  log("WARN", "json", "all parse strategies failed", { preview: text.slice(0, 200) });
  return null;
}
