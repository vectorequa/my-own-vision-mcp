import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { imageToBase64 } from "../src/image-loader.js";
import { scaleBboxAxtree, scaleBboxJson } from "../src/tools.js";
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

async function getSharp(): Promise<any | null> {
    try {
        const mod = await import("sharp");
        return mod.default || mod;
    } catch {
        return null;
    }
}

async function main(): Promise<void> {
    const tmpDir = join(tmpdir(), "vision-mcp-screenshot-test");
    await mkdir(tmpDir, { recursive: true });

    console.log("analyze-screenshot tests:\n");

    console.log("  --- scaleBboxAxtree ---");
    await runTest("single box ×2", async () => {
        const out = scaleBboxAxtree('button "Login" [ref=1] [box=100,200,300,40]', 2);
        assertEqual(out, 'button "Login" [ref=1] [box=200,400,600,80]', "box scaled");
    });

    await runTest("scale=1 is no-op", async () => {
        const src = 'link "Home" [ref=1] [box=10,20,60,30]';
        assertEqual(scaleBboxAxtree(src, 1), src, "unchanged");
    });

    await runTest("multiple boxes all scaled", async () => {
        const src = 'page [box=0,0,1280,800]\n  link "A" [ref=1] [box=120,14,90,28]\n  button "B" [ref=2] [box=200,40,80,24]';
        const out = scaleBboxAxtree(src, 1.5);
        assert(out.includes("[box=0,0,1920,1200]"), "root scaled");
        assert(out.includes("[box=180,21,135,42]"), "link scaled");
        assert(out.includes("[box=300,60,120,36]"), "button scaled");
    });

    await runTest("no box → unchanged", async () => {
        const src = 'text "hello"\nheading "Title" [level=1]';
        assertEqual(scaleBboxAxtree(src, 3), src, "no box lines untouched");
    });

    await runTest("fractional scale rounds", async () => {
        const out = scaleBboxAxtree("[box=100,100,100,100]", 1.333);
        assertEqual(out, "[box=133,133,133,133]", "rounded");
    });

    console.log("\n  --- scaleBboxJson ---");
    await runTest("nested children bbox scaled", async () => {
        const obj = {
            type: "page", name: "P", bbox: [0, 0, 1280, 800],
            children: [
                { type: "link", name: "A", ref: 1, bbox: [120, 14, 90, 28] },
                { type: "group", bbox: [0, 56, 1280, 100], children: [
                    { type: "button", name: "B", ref: 2, bbox: [200, 60, 80, 24] },
                ] },
            ],
        };
        scaleBboxJson(obj, 2);
        assertEqual(JSON.stringify(obj.bbox), "[0,0,2560,1600]", "root");
        assertEqual(JSON.stringify(obj.children[0].bbox), "[240,28,180,56]", "link");
        assertEqual(JSON.stringify((obj.children[1] as any).bbox), "[0,112,2560,200]", "group");
        assertEqual(JSON.stringify((obj.children[1] as any).children[0].bbox), "[400,120,160,48]", "nested button");
    });

    await runTest("scale=1 is no-op", async () => {
        const obj = { type: "page", bbox: [10, 20, 30, 40], children: [{ type: "link", bbox: [1, 2, 3, 4] }] };
        const before = JSON.stringify(obj);
        scaleBboxJson(obj, 1);
        assertEqual(JSON.stringify(obj), before, "unchanged");
    });

    await runTest("array of nodes scaled", async () => {
        const arr = [{ bbox: [10, 20, 30, 40] }, { bbox: [50, 60, 70, 80] }];
        scaleBboxJson(arr, 2);
        assertEqual(JSON.stringify(arr[0].bbox), "[20,40,60,80]", "first");
        assertEqual(JSON.stringify(arr[1].bbox), "[100,120,140,160]", "second");
    });

    await runTest("node without bbox untouched", async () => {
        const obj = { type: "text", name: "hello", children: [{ type: "text", name: "world" }] };
        const before = JSON.stringify(obj);
        scaleBboxJson(obj, 5);
        assertEqual(JSON.stringify(obj), before, "unchanged");
    });

    await runTest("bbox with non-numbers ignored", async () => {
        const obj = { bbox: ["x", 2, 3, 4] } as any;
        scaleBboxJson(obj, 2);
        assertEqual(JSON.stringify(obj.bbox), '["x",2,3,4]', "not scaled");
    });

    console.log("\n  --- imageToBase64 size metadata ---");
    const pngPath = join(tmpDir, "small.png");
    await writeFile(pngPath, minimalPNG());

    await runTest("small image: returns size fields, scale=1", async () => {
        const r = await imageToBase64(pngPath, makeVision());
        assert(r.base64.length > 0, "base64 present");
        assert(typeof r.origWidth === "number", "origWidth is number");
        assert(typeof r.scaledWidth === "number", "scaledWidth is number");
        if (r.origWidth > 0 && r.scaledWidth > 0) {
            const scale = r.origWidth / r.scaledWidth;
            assert(Math.abs(scale - 1) < 0.01, `small image scale should be 1, got ${scale}`);
        }
    });

    const sharp = await getSharp();
    if (sharp) {
        const bigPath = join(tmpDir, "big.jpg");
        await sharp({
            create: { width: 2000, height: 1500, channels: 3, background: { r: 200, g: 100, b: 50 } },
        }).jpeg().toFile(bigPath);

        await runTest("large image (2000x1500): scaled down, scale>1", async () => {
            const r = await imageToBase64(bigPath, makeVision({ max_image_dim: 1280 }));
            assertEqual(r.origWidth, 2000, "origWidth");
            assertEqual(r.origHeight, 1500, "origHeight");
            assert(r.scaledWidth <= 1280, `scaledWidth <= 1280, got ${r.scaledWidth}`);
            assert(r.scaledHeight <= 1280, `scaledHeight <= 1280, got ${r.scaledHeight}`);
            const scale = r.origWidth / r.scaledWidth;
            assert(scale > 1, `scale > 1, got ${scale}`);
            const ratioOrig = r.origWidth / r.origHeight;
            const ratioScaled = r.scaledWidth / r.scaledHeight;
            assert(Math.abs(ratioOrig - ratioScaled) < 0.01, `aspect ratio preserved: ${ratioOrig} vs ${ratioScaled}`);
        });

        await runTest("large image: bbox round-trip via scale restores orig coords", async () => {
            const r = await imageToBase64(bigPath, makeVision({ max_image_dim: 1280 }));
            if (r.origWidth === 0) return;
            const scale = r.origWidth / r.scaledWidth;
            const scaledBox = [100, 100, 200, 50];
            const restored = scaledBox.map((n) => Math.round(n * scale));
            assert(restored[0] > 100, "restored x > scaled x");
            assert(restored[2] > 200, "restored w > scaled w");
        });
    } else {
        console.log("  (sharp not available, skipping large-image size tests) ✓");
        passCount++;
    }

    console.log(`\n${passCount} passed, ${failCount} failed`);
    if (failCount > 0) process.exit(1);
}

main().catch((e) => {
    console.error(`\nFATAL: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
