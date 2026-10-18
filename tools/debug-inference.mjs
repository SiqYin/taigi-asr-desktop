/**
 * 診斷推理為何逾時：分階段量測，並回報執行緒數與 WASM 記憶體狀態。
 *
 * 用法：node tools/debug-inference.mjs
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");
const TOOLS = join(ROOT, "tools");
const CACHE = join(ROOT, ".cache");
const PORT = 4329;

const MODEL = join(CACHE, "models", "breeze-q4_0.bin");
const AUDIO = join(CACHE, "audio", "test.m4a");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
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
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  protocolTimeout: 40 * 60 * 1000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-features=SharedArrayBuffer"],
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("[probe]") || m.type() === "error") console.log(t.slice(0, 300));
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle2" });
  await page
    .waitForFunction(() => globalThis.crossOriginIsolated === true, { timeout: 30000 })
    .catch(() => {});
  if (!(await page.evaluate(() => globalThis.crossOriginIsolated))) {
    await page.reload({ waitUntil: "networkidle2" });
    await page
      .waitForFunction(() => globalThis.crossOriginIsolated === true, { timeout: 30000 })
      .catch(() => {});
  }
  console.log("crossOriginIsolated =", await page.evaluate(() => globalThis.crossOriginIsolated));
  console.log("hardwareConcurrency =", await page.evaluate(() => navigator.hardwareConcurrency));

  const result = await page.evaluate(
    async ({ modelUrl, audioUrl }) => {
      const t = {};
      const mark = (k) => {
        t[k] = Math.round(performance.now());
      };
      mark("start");

      // 音訊解碼
      const resp = await fetch(audioUrl);
      const buf = await resp.arrayBuffer();
      mark("audioFetched");
      const ctx = new AudioContext();
      const decoded = await ctx.decodeAudioData(buf);
      await ctx.close();
      mark("audioDecoded");

      const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
      const off = new OfflineAudioContext(1, frames, 16000);
      const src = off.createBufferSource();
      src.buffer = decoded;
      src.connect(off.destination);
      src.start(0);
      const rendered = await off.startRendering();
      const pcm = rendered.getChannelData(0);
      mark("resampled");

      const worker = new Worker(new URL("/__probe/inference-worker.js", location.href).href, {
        type: "module",
      });

      const events = [];
      const waitFor = (types, timeout = 25 * 60 * 1000) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`逾時，已收到：${events.join(" | ")}`)), timeout);
          const handler = (ev) => {
            const d = ev.data || {};
            events.push(`${d.type}${d.message ? ":" + String(d.message).slice(0, 80) : ""}`);
            if (d.type === "status") console.log(`[probe] ${d.phase}: ${d.message}`);
            if (types.includes(d.type)) {
              clearTimeout(timer);
              worker.removeEventListener("message", handler);
              resolve(d);
            }
            if (d.type === "error") {
              clearTimeout(timer);
              worker.removeEventListener("message", handler);
              reject(new Error(d.message));
            }
          };
          worker.addEventListener("message", handler);
        });

      try {
        worker.postMessage({
          type: "run",
          base: new URL("/wasm/", location.href).href,
          modelUrl,
          pcm: new Float32Array(pcm),
        });
        mark("workerPosted");
        const done = await waitFor(["done"]);
        mark("done");
        return {
          ok: true,
          t,
          events,
          segments: done.segments,
          modelLoadMs: done.modelLoadMs,
          inferMs: done.inferMs,
          audioDuration: decoded.duration,
        };
      } catch (err) {
        return { ok: false, error: err?.message, events, t };
      } finally {
        worker.terminate();
      }
    },
    { modelUrl: "/__cache/models/breeze-q4_0.bin", audioUrl: "/__cache/audio/test.m4a" },
  );

  console.log("\n=== 結果 ===");
  console.log(JSON.stringify({ ...result, segments: result.segments?.slice(0, 3) }, null, 2));
} finally {
  await browser.close();
  server.close();
}
