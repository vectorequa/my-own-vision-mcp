import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import type { VisionConfig } from "./config.js";
import { log } from "./logger.js";

export class ImageError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "ImageError";
  }
}

export interface ImageEncoded {
    base64: string;
    mimeType: string;
    origWidth: number;
    origHeight: number;
    scaledWidth: number;
    scaledHeight: number;
}

const LLM_SUPPORTED_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const IMAGE_SIGNATURES: Array<{ bytes: number[]; mime: string }> = [
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: "image/png" },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: "image/gif" },
  { bytes: [0x42, 0x4d], mime: "image/bmp" },
  { bytes: [0x49, 0x49, 0x2a, 0x00], mime: "image/tiff" },
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], mime: "image/tiff" },
];

const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", bmp: "image/bmp", webp: "image/webp",
  tiff: "image/tiff", tif: "image/tiff",
};

function detectMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer.slice(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  for (const sig of IMAGE_SIGNATURES) {
    if (buffer.length < sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => buffer[i] === b)) return sig.mime;
  }
  return null;
}

function isBase64(s: string): boolean {
  const cleaned = s.replace(/\s/g, "");
  if (cleaned.length < 8 || cleaned.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(cleaned);
}

let sharpInstance: any = null;
let sharpChecked = false;

async function getSharp(): Promise<any | null> {
  if (sharpChecked) return sharpInstance;
  sharpChecked = true;
  try {
    const mod = await import("sharp");
    sharpInstance = mod.default || mod;
  } catch {
    log("WARN", "image", "sharp not available, preprocessing disabled");
  }
  return sharpInstance;
}

function checkSize(buffer: Buffer, max: number): void {
  if (buffer.length > max) {
    throw new ImageError(
      `Image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (max: ${(max / 1024 / 1024).toFixed(1)}MB)`,
    );
  }
}

function resolveMime(buffer: Buffer, hint?: string): string {
  const detected = detectMimeType(buffer);
  if (detected) return detected;
  if (hint && hint.startsWith("image/")) return hint;
  return "image/jpeg";
}

export async function loadAsBuffer(
  source: string,
  vision: VisionConfig,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!source || source.trim().length === 0) {
    throw new ImageError("Image source is empty");
  }

  if (source.startsWith("data:")) {
    const match = source.match(/^data:([^;,]*)(?:;[^,]*)*;base64,(.+)$/is);
    if (!match) {
      throw new ImageError("Invalid data URI: expected data:<mime>;base64,<data>");
    }
    const mimeType = match[1] || "image/jpeg";
    const cleaned = match[2].replace(/\s/g, "");
    const buffer = Buffer.from(cleaned, "base64");
    if (buffer.length === 0) throw new ImageError("Data URI contains empty image data");
    checkSize(buffer, vision.max_image_size);
    const resolved = resolveMime(buffer, mimeType);
    return { buffer, mimeType: resolved };
  }

  if (source.startsWith("http://") || source.startsWith("https://")) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), vision.url_timeout * 1000);
    let resp: Response;
    try {
      resp = await fetch(source, { signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof Error && e.name === "AbortError") {
        throw new ImageError(`URL fetch timed out after ${vision.url_timeout}s: ${source}`, e);
      }
      throw new ImageError(`URL fetch failed: ${e instanceof Error ? e.message : String(e)}`, e);
    }
    clearTimeout(timer);
    if (!resp.ok) {
      throw new ImageError(`URL fetch failed: HTTP ${resp.status} ${resp.statusText}`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length === 0) throw new ImageError("URL returned empty response");
    checkSize(buffer, vision.max_image_size);
    const ct = resp.headers.get("content-type") || "";
    const hint = ct.split(";")[0].trim() || undefined;
    const resolved = resolveMime(buffer, hint);
    return { buffer, mimeType: resolved };
  }

  if (existsSync(source)) {
    const stat = statSync(source);
    if (stat.size > vision.max_image_size) {
      throw new ImageError(
        `File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max: ${(vision.max_image_size / 1024 / 1024).toFixed(1)}MB): ${source}`,
      );
    }
    const buffer = await readFile(source);
    if (buffer.length === 0) throw new ImageError(`File is empty: ${source}`);
    const ext = source.split(".").pop()?.toLowerCase() || "";
    const hint = EXT_TO_MIME[ext];
    const resolved = resolveMime(buffer, hint);
    return { buffer, mimeType: resolved };
  }

  if (isBase64(source)) {
    const cleaned = source.replace(/\s/g, "");
    const buffer = Buffer.from(cleaned, "base64");
    if (buffer.length === 0) throw new ImageError("Base64 string decodes to empty data");
    checkSize(buffer, vision.max_image_size);
    const detected = detectMimeType(buffer);
    if (!detected) {
      throw new ImageError(
        "Base64 string does not contain a recognized image format (checked JPEG, PNG, GIF, BMP, WebP, TIFF magic bytes)",
      );
    }
    return { buffer, mimeType: detected };
  }

  throw new ImageError(
    `Cannot resolve image source: not a data URI, URL, existing file path, or valid base64 image. Source preview: "${source.slice(0, 80)}${source.length > 80 ? "..." : ""}"`,
  );
}

export async function preprocess(
  buffer: Buffer,
  vision: VisionConfig,
): Promise<ImageEncoded> {
  const sharp = await getSharp();
  if (!sharp) {
    const detected = detectMimeType(buffer);
    if (!detected) {
      throw new ImageError(
        "Cannot process image: sharp not installed and image format not detected. Install sharp: npm install sharp",
      );
    }
    if (!LLM_SUPPORTED_MIMES.has(detected)) {
      throw new ImageError(
        `Cannot process image: sharp not installed and format '${detected}' is not directly supported by LLM APIs. Install sharp: npm install sharp`,
      );
    }
    return { base64: buffer.toString("base64"), mimeType: detected, origWidth: 0, origHeight: 0, scaledWidth: 0, scaledHeight: 0 };
  }

  try {
    const meta = await sharp(buffer).metadata();
    const maxDim = Math.max(meta.width || 0, meta.height || 0);
    let pipeline = sharp(buffer);

    if (maxDim > vision.max_image_dim) {
      pipeline = pipeline.resize({
        width: vision.max_image_dim,
        height: vision.max_image_dim,
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    const output = await pipeline
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: vision.jpeg_quality })
      .toBuffer();

    const outMeta = await sharp(output).metadata();
    return {
      base64: output.toString("base64"),
      mimeType: "image/jpeg",
      origWidth: meta.width || 0,
      origHeight: meta.height || 0,
      scaledWidth: outMeta.width || 0,
      scaledHeight: outMeta.height || 0,
    };
  } catch (e) {
    log("WARN", "image", "sharp preprocessing failed, falling back", { error: e instanceof Error ? e.message : String(e) });
    const detected = detectMimeType(buffer);
    if (detected && LLM_SUPPORTED_MIMES.has(detected)) {
      return { base64: buffer.toString("base64"), mimeType: detected, origWidth: 0, origHeight: 0, scaledWidth: 0, scaledHeight: 0 };
    }
    throw new ImageError(
      `Image preprocessing failed and no fallback available: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

export async function imageToBase64(
  source: string,
  vision: VisionConfig,
): Promise<ImageEncoded> {
  const { buffer } = await loadAsBuffer(source, vision);
  return preprocess(buffer, vision);
}
