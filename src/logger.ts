import { appendFileSync, mkdirSync, statSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const LOG_DIR = join(PROJECT_ROOT, "logs");

let maxFileSize = 1048576;
let maxFiles = 10;

export function initLogger(opts: { maxFileSize: number; maxFiles: number }): void {
    maxFileSize = opts.maxFileSize;
    maxFiles = opts.maxFiles;
}

let reqCounter = 0;

export function nextReqId(): string {
    return (++reqCounter).toString(36).padStart(4, "0");
}

function localTimestamp(d: Date = new Date()): string {
    const pad = (n: number, len = 2): string => n.toString().padStart(len, "0");
    const y = d.getFullYear();
    const mo = pad(d.getMonth() + 1);
    const da = pad(d.getDate());
    const h = pad(d.getHours());
    const mi = pad(d.getMinutes());
    const s = pad(d.getSeconds());
    const ms = pad(d.getMilliseconds(), 3);
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const abs = Math.abs(off);
    const oh = pad(Math.floor(abs / 60));
    const om = pad(abs % 60);
    return `${y}-${mo}-${da}T${h}:${mi}:${s}.${ms}${sign}${oh}:${om}`;
}

function formatValue(v: unknown): string {
    if (v === undefined) return "";
    if (v === null) return "null";
    const s = typeof v === "string" ? v : String(v);
    if (s.includes(" ") || s.includes('"')) return `"${s.replace(/"/g, '\\"')}"`;
    return s;
}

const CLIENT_ID = process.env.MY_OWN_VISION_MCP_CLIENT || "default";
const LOG_FILE = join(LOG_DIR, `${CLIENT_ID}.log`);

let logFileReady = false;
try {
    mkdirSync(LOG_DIR, { recursive: true });
    logFileReady = true;
} catch { /* ignore */ }

let writeCount = 0;

function rotateIfNeeded(): void {
    if (writeCount % 64 !== 0) return;
    writeCount = 0;
    try {
        if (!existsSync(LOG_FILE) || statSync(LOG_FILE).size <= maxFileSize) return;
        const oldest = `${LOG_FILE}.${maxFiles}`;
        if (existsSync(oldest)) unlinkSync(oldest);
        for (let i = maxFiles - 1; i >= 1; i--) {
            const from = `${LOG_FILE}.${i}`;
            const to = `${LOG_FILE}.${i + 1}`;
            if (existsSync(from)) renameSync(from, to);
        }
        renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch { /* ignore */ }
}

export function log(
    level: "INFO" | "WARN" | "ERROR" | "DEBUG",
    category: "config" | "tool" | "llm" | "image" | "json" | "server",
    msg: string,
    fields?: Record<string, unknown>,
): void {
    const ts = localTimestamp();
    const f = fields
        ? " " + Object.entries(fields)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${formatValue(v)}`)
            .join(" ")
        : "";
    const line = `[my-own-vision-mcp] ${ts} ${level} ${category} ${msg}${f}`;
    console.error(line);
    if (logFileReady) {
        try {
            rotateIfNeeded();
            appendFileSync(LOG_FILE, line + "\n");
            writeCount++;
        } catch { /* never crash on logging */ }
    }
}

export function getLogInfo(): { client: string; logFile: string } {
    return { client: CLIENT_ID, logFile: logFileReady ? LOG_FILE : "(none)" };
}

export function describeImageSource(source: string): string {
    if (source.startsWith("data:")) return "data-uri";
    if (source.startsWith("http://") || source.startsWith("https://")) {
        return `url:${source.slice(0, 80)}`;
    }
    if (source.length > 500 && /^[A-Za-z0-9+/]/.test(source)) return `base64(len=${source.length})`;
    return `file:${source.slice(0, 120)}`;
}
