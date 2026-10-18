/**
 * 效能剖析：量測 whisper.cpp 在 WASM 下各階段耗時，找出真正的瓶頸。
 *
 * 用法：node tools/profile-inference.mjs
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { requireBrowser } from "./chrome.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");
const TOOLS = join(ROOT, "tools");
const CACHE = join(ROOT, ".cache");
const PORT = 4337;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".png": "image/png",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  let base = WEB;
  if (pathname.startsWith("/__probe/")) {
    base = TOOLS;
    pathname = pathname.slice("/__probe".length);
  } else if (pathname.startsWith("/__cache/")) {
    base = CACHE;
    pathname = pathname.slice("/__cache".length);
  }
  if (pathname === "/") pathname = "/index.html";
  const target = normalize(join(base, pathname));
  if (!target.startsWith(base)) return res.writeHead(403).end();
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return res.writeHead(404).end("nf");
  const type = MIME[extname(target).toLowerCase()] || "application/octet-stream";
  if (info.size > 16 * 1024 * 1024) {
    res.writeHead(200, { "Content-Type": type, "Content-Length": info.size });
    createReadStream(target).pipe(res);
    return;
  }
  const body = await readFile(target);
  res.writeHead(200, { "Content-Type": type, "Content-Length": body.length });
  res.end(body);
});
await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));

const browser = await puppeteer.launch({
  executablePath: requireBrowser(),
  headless: true,
  protocolTimeout: 40 * 60 * 1000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-features=SharedArrayBuffer"],
});

try {
  const page = await browser.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("[prof]")) console.log(t.slice(0, 200));
  });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle2" });
  await page
    .waitForFunction(() => globalThis.crossOriginIsolated === true, { timeout: 30000 })
    .catch(() => {});
  if (!(await page.evaluate(() => globalThis.crossOriginIsolated))) {
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForFunction(() => globalThis.crossOriginIsolated === true, { timeout: 30000 });
  }

  const result = await page.evaluate(async () => {
    const wasmBase = new URL("/wasm/", location.href).href;

    // Web Audio API 只在主執行緒可用，先在這裡解碼成 16 kHz 單聲道，
    // 再把 PCM 交給 Worker 做推理。
    const resp = await fetch("/__cache/audio/jfk.wav");
    const buf = await resp.arrayBuffer();
    const ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(buf);
    await ctx.close();
    const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
    const off = new OfflineAudioContext(1, frames, 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    const pcm = new Float32Array(rendered.getChannelData(0));

    const worker = new Worker(new URL("/__probe/profile-worker.js", location.href).href, {
      type: "module",
    });

    const wait = (type, timeout = 30 * 60 * 1000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${type} 逾時`)), timeout);
        const handler = (ev) => {
          const d = ev.data || {};
          if (d.type === type) {
            clearTimeout(timer);
            worker.removeEventListener("message", handler);
            resolve(d);
          } else if (d.type === "error") {
            clearTimeout(timer);
            worker.removeEventListener("message", handler);
            reject(new Error(d.message));
          } else if (d.type === "status") {
            console.log(`[prof] ${d.message}`);
          }
        };
        worker.addEventListener("message", handler);
      });

    try {
      worker.postMessage({
        type: "profile",
        base: wasmBase,
        modelUrl: "/__cache/models/breeze-q4_0.bin",
        pcm,
        audioDuration: decoded.duration,
      });
      return await wait("profile-done");
    } catch (err) {
      return { error: err?.message };
    } finally {
      worker.terminate();
    }
  });

  console.log("\n=== 效能剖析結果 ===");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  server.close();
}
