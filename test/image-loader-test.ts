import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { loadAsBuffer, preprocess, imageToBase64, ImageError } from "../src/image-loader.js";
import type { VisionConfig } from "../src/config.js";

let passCount = 0;
let failCount = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passCount++;
    console.log(`  ${name} ✓`);
  } catch (e) {
    failCount++;
    console.error(`  ${name} ✗ — ${e instanceof Error ? e.message : String(e)}`);
  }
}

function makeVision(overrides?: Partial<VisionConfig>): VisionConfig {
  return {
    max_image_dim: 1280,
    jpeg_quality: 85,
    max_image_size: 20 * 1024 * 1024,
    url_timeout: 5,
    ...overrides,
  };
}

function minimalPNG(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
}

function minimalJPEG(): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
    0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
    0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c,
    0xff, 0xd9,
  ]);
}

function minimalGIF(): Buffer {
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02,
    0x02, 0x44, 0x01, 0x00, 0x3b,
  ]);
}

function minimalBMP(): Buffer {
  return Buffer.from([
    0x42, 0x4d, 0x3e, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x36, 0x00, 0x00, 0x00, 0x28, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
  ]);
}

function minimalWebP(): Buffer {
  const buf = Buffer.alloc(26, 0);
  buf[0] = 0x52; buf[1] = 0x49; buf[2] = 0x46; buf[3] = 0x46;
  buf.write("WEBP", 8);
  buf.write("VP8 ", 12);
  return buf;
}

function nonImageBuffer(): Buffer {
  return Buffer.from("This is not an image, just plain text data here.");
}

async function withMockServer(
  handler: (req: any, res: any) => void,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

async function main(): Promise<void> {
  const tmpDir = join(tmpdir(), "vision-mcp-test");
  await mkdir(tmpDir, { recursive: true });

  const pngPath = join(tmpDir, "test.png");
  const jpgPath = join(tmpDir, "test.jpg");
  const gifPath = join(tmpDir, "test.gif");
  const bmpPath = join(tmpDir, "test.bmp");
  const webpPath = join(tmpDir, "test.webp");
  const fakePngPath = join(tmpDir, "actually_jpeg.png");
  const nonImgPath = join(tmpDir, "not_image.txt");

  await writeFile(pngPath, minimalPNG());
  await writeFile(jpgPath, minimalJPEG());
  await writeFile(gifPath, minimalGIF());
  await writeFile(bmpPath, minimalBMP());
  await writeFile(webpPath, minimalWebP());
  await writeFile(fakePngPath, minimalJPEG());
  await writeFile(nonImgPath, nonImageBuffer());

  console.log("image-loader tests:\n");

  console.log("  --- file path loading ---");
  await runTest("file: PNG → image/png", async () => {
    const { buffer, mimeType } = await loadAsBuffer(pngPath, makeVision());
    assertEqual(mimeType, "image/png", "MIME");
    assert(buffer.length > 0, "buffer not empty");
  });

  await runTest("file: JPEG → image/jpeg", async () => {
    const { buffer, mimeType } = await loadAsBuffer(jpgPath, makeVision());
    assertEqual(mimeType, "image/jpeg", "MIME");
  });

  await runTest("file: GIF → image/gif", async () => {
    const { buffer, mimeType } = await loadAsBuffer(gifPath, makeVision());
    assertEqual(mimeType, "image/gif", "MIME");
  });

  await runTest("file: BMP → image/bmp", async () => {
    const { buffer, mimeType } = await loadAsBuffer(bmpPath, makeVision());
    assertEqual(mimeType, "image/bmp", "MIME");
  });

  await runTest("file: WebP → image/webp", async () => {
    const { buffer, mimeType } = await loadAsBuffer(webpPath, makeVision());
    assertEqual(mimeType, "image/webp", "MIME");
  });

  await runTest("file: wrong extension (.png but JPEG content) → image/jpeg", async () => {
    const { buffer, mimeType } = await loadAsBuffer(fakePngPath, makeVision());
    assertEqual(mimeType, "image/jpeg", "MIME should be detected from content, not extension");
  });

  await runTest("file: non-image .txt → image/jpeg (fallback)", async () => {
    const { buffer, mimeType } = await loadAsBuffer(nonImgPath, makeVision());
    assertEqual(mimeType, "image/jpeg", "MIME falls back to extension hint then jpeg");
  });

  console.log("\n  --- data URI ---");
  await runTest("data URI: image/png;base64,...", async () => {
    const b64 = minimalPNG().toString("base64");
    const source = `data:image/png;base64,${b64}`;
    const { buffer, mimeType } = await loadAsBuffer(source, makeVision());
    assertEqual(mimeType, "image/png", "MIME");
  });

  await runTest("data URI: image/jpeg;base64,...", async () => {
    const b64 = minimalJPEG().toString("base64");
    const source = `data:image/jpeg;base64,${b64}`;
    const { buffer, mimeType } = await loadAsBuffer(source, makeVision());
    assertEqual(mimeType, "image/jpeg", "MIME");
  });

  await runTest("data URI: no MIME type (data:;base64,...)", async () => {
    const b64 = minimalPNG().toString("base64");
    const source = `data:;base64,${b64}`;
    const { buffer, mimeType } = await loadAsBuffer(source, makeVision());
    assertEqual(mimeType, "image/png", "MIME detected from content");
  });

  await runTest("data URI: extra params (name=x.png)", async () => {
    const b64 = minimalPNG().toString("base64");
    const source = `data:image/png;name=x.png;base64,${b64}`;
    const { buffer, mimeType } = await loadAsBuffer(source, makeVision());
    assertEqual(mimeType, "image/png", "MIME");
  });

  await runTest("data URI: whitespace in base64 (newlines every 76 chars)", async () => {
    const b64 = minimalPNG().toString("base64");
    const wrapped = b64.match(/.{1,76}/g)!.join("\n");
    const source = `data:image/png;base64,${wrapped}`;
    const { buffer, mimeType } = await loadAsBuffer(source, makeVision());
    assertEqual(mimeType, "image/png", "MIME");
    assert(buffer.length === minimalPNG().length, "buffer length matches after whitespace strip");
  });

  await runTest("data URI: invalid format → error", async () => {
    try {
      await loadAsBuffer("data:image/png;base64", makeVision());
      throw new Error("should have thrown");
    } catch (e) {
      assert(e instanceof ImageError, "should be ImageError");
    }
  });

  console.log("\n  --- raw base64 ---");
  await runTest("raw base64: PNG → image/png", async () => {
    const b64 = minimalPNG().toString("base64");
    const { buffer, mimeType } = await loadAsBuffer(b64, makeVision());
    assertEqual(mimeType, "image/png", "MIME");
  });

  await runTest("raw base64: JPEG → image/jpeg", async () => {
    const b64 = minimalJPEG().toString("base64");
    const { buffer, mimeType } = await loadAsBuffer(b64, makeVision());
    assertEqual(mimeType, "image/jpeg", "MIME");
  });

  await runTest("raw base64: with whitespace (newlines)", async () => {
    const b64 = minimalPNG().toString("base64");
    const wrapped = b64.match(/.{1,40}/g)!.join("\n");
    const { buffer, mimeType } = await loadAsBuffer(wrapped, makeVision());
    assertEqual(mimeType, "image/png", "MIME");
  });

  await runTest("raw base64: non-image data → error", async () => {
    const b64 = nonImageBuffer().toString("base64");
    try {
      await loadAsBuffer(b64, makeVision());
      throw new Error("should have thrown");
    } catch (e) {
      assert(e instanceof ImageError, "should be ImageError");
      assert(e.message.includes("recognized image format"), `message should mention format: ${e.message}`);
    }
  });

  await runTest("raw base64: too short → error (not base64)", async () => {
    try {
      await loadAsBuffer("abc", makeVision());
      throw new Error("should have thrown");
    } catch (e) {
      assert(e instanceof ImageError, "should be ImageError");
    }
  });

  console.log("\n  --- error cases ---");
  await runTest("empty source → error", async () => {
    try {
      await loadAsBuffer("", makeVision());
      throw new Error("should have thrown");
    } catch (e) {
      assert(e instanceof ImageError, "should be ImageError");
    }
  });

  await runTest("whitespace-only source → error", async () => {
    try {
      await loadAsBuffer("   ", makeVision());
      throw new Error("should have thrown");
    } catch (e) {
      assert(e instanceof ImageError, "should be ImageError");
    }
  });

  await runTest("non-existent path, not base64 → error", async () => {
    try {
      await loadAsBuffer("C:\\nonexistent\\path\\image.png", makeVision());
      throw new Error("should have thrown");
    } catch (e) {
      assert(e instanceof ImageError, "should be ImageError");
      assert(e.message.includes("Cannot resolve"), `message should explain: ${e.message}`);
    }
  });

  await runTest("random text (not file, not base64) → error", async () => {
    try {
      await loadAsBuffer("hello world this is not an image", makeVision());
      throw new Error("should have thrown");
    } catch (e) {
      assert(e instanceof ImageError, "should be ImageError");
    }
  });

  await runTest("file too large → error", async () => {
    try {
      await loadAsBuffer(pngPath, makeVision({ max_image_size: 10 }));
      throw new Error("should have thrown");
    } catch (e) {
      assert(e instanceof ImageError, "should be ImageError");
      assert(e.message.includes("too large"), `message should mention size: ${e.message}`);
    }
  });

  console.log("\n  --- URL fetch ---");
  await runTest("URL: success with content-type image/png", async () => {
    const pngData = minimalPNG();
    await withMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(pngData);
    }, async (port) => {
      const { buffer, mimeType } = await loadAsBuffer(`http://127.0.0.1:${port}/img`, makeVision());
      assertEqual(mimeType, "image/png", "MIME");
      assert(buffer.length === pngData.length, "buffer length matches");
    });
  });

  await runTest("URL: success with wrong content-type (text/plain) but PNG content", async () => {
    const pngData = minimalPNG();
    await withMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(pngData);
    }, async (port) => {
      const { buffer, mimeType } = await loadAsBuffer(`http://127.0.0.1:${port}/img`, makeVision());
      assertEqual(mimeType, "image/png", "MIME detected from content, not content-type header");
    });
  });

  await runTest("URL: 404 → error", async () => {
    await withMockServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }, async (port) => {
      try {
        await loadAsBuffer(`http://127.0.0.1:${port}/img`, makeVision());
        throw new Error("should have thrown");
      } catch (e) {
        assert(e instanceof ImageError, "should be ImageError");
        assert(e.message.includes("404"), `message should mention 404: ${e.message}`);
      }
    });
  });

  await runTest("URL: empty response → error", async () => {
    await withMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end();
    }, async (port) => {
      try {
        await loadAsBuffer(`http://127.0.0.1:${port}/img`, makeVision());
        throw new Error("should have thrown");
      } catch (e) {
        assert(e instanceof ImageError, "should be ImageError");
        assert(e.message.includes("empty"), `message should mention empty: ${e.message}`);
      }
    });
  });

  await runTest("URL: timeout → error", async () => {
    await withMockServer((_req, res) => {
      setTimeout(() => { res.writeHead(200); res.end(minimalPNG()); }, 10000);
    }, async (port) => {
      try {
        await loadAsBuffer(`http://127.0.0.1:${port}/img`, makeVision({ url_timeout: 1 }));
        throw new Error("should have thrown");
      } catch (e) {
        assert(e instanceof ImageError, "should be ImageError");
        assert(e.message.includes("timed out"), `message should mention timeout: ${e.message}`);
      }
    });
  });

  await runTest("URL: too large → error", async () => {
    const pngData = minimalPNG();
    await withMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(pngData);
    }, async (port) => {
      try {
        await loadAsBuffer(`http://127.0.0.1:${port}/img`, makeVision({ max_image_size: 10 }));
        throw new Error("should have thrown");
      } catch (e) {
        assert(e instanceof ImageError, "should be ImageError");
        assert(e.message.includes("too large"), `message should mention size: ${e.message}`);
      }
    });
  });

  console.log("\n  --- preprocess (with sharp if available) ---");
  await runTest("preprocess: JPEG buffer → base64 output", async () => {
    const { base64, mimeType } = await preprocess(minimalJPEG(), makeVision());
    assert(base64.length > 0, "base64 not empty");
    assert(mimeType.startsWith("image/"), `MIME should be image/*, got ${mimeType}`);
  });

  await runTest("preprocess: PNG buffer → base64 output", async () => {
    const { base64, mimeType } = await preprocess(minimalPNG(), makeVision());
    assert(base64.length > 0, "base64 not empty");
    assert(mimeType.startsWith("image/"), `MIME should be image/*, got ${mimeType}`);
  });

  await runTest("preprocess: non-image buffer → error or fallback", async () => {
    try {
      const result = await preprocess(nonImageBuffer(), makeVision());
      assert(result.base64.length > 0, "if it returns, base64 should not be empty");
    } catch (e) {
      assert(e instanceof ImageError || e instanceof Error, "should throw Error");
    }
  });

  console.log("\n  --- imageToBase64 (end-to-end) ---");
  await runTest("imageToBase64: file path → base64 + MIME", async () => {
    const { base64, mimeType } = await imageToBase64(pngPath, makeVision());
    assert(base64.length > 0, "base64 not empty");
    assert(mimeType.startsWith("image/"), `MIME should be image/*, got ${mimeType}`);
  });

  await runTest("imageToBase64: data URI → base64 + MIME", async () => {
    const b64 = minimalJPEG().toString("base64");
    const { base64, mimeType } = await imageToBase64(`data:image/jpeg;base64,${b64}`, makeVision());
    assert(base64.length > 0, "base64 not empty");
    assert(mimeType.startsWith("image/"), `MIME should be image/*, got ${mimeType}`);
  });

  await runTest("imageToBase64: raw base64 → base64 + MIME", async () => {
    const b64 = minimalPNG().toString("base64");
    const { base64, mimeType } = await imageToBase64(b64, makeVision());
    assert(base64.length > 0, "base64 not empty");
    assert(mimeType.startsWith("image/"), `MIME should be image/*, got ${mimeType}`);
  });

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`\nFATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
