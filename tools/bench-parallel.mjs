/**
 * 比較 full_default 與 full_parallel 的速度，確認平行處理真的有效。
 *
 * 用法：node tools/bench-parallel.mjs [音訊路徑]
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");
const TOOLS = join(ROOT, "tools");
const CACHE = join(ROOT, ".cache");
const PORT = 4333;

const AUDIO = process.argv[2] || join(CACHE, "audio", "jfk.wav");
const MODEL = join(CACHE, "models", "breeze-q4_0.bin");

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

if (!existsSync(AUDIO)) {
  console.error(`找不到音訊：${AUDIO}`);
  process.exit(2);
}
if (!existsSync(MODEL)) {
  console.error(`找不到模型：${MODEL}`);
  process.exit(2);
}
console.log(`音訊：${AUDIO}`);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  protocolTimeout: 40 * 60 * 1000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-features=SharedArrayBuffer"],
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

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

  const audioName = AUDIO.split(/[\\/]/).pop();
  const result = await page.evaluate(
    async ({ modelUrl, audioUrl }) => {
      // 解碼音訊
      const resp = await fetch(audioUrl);
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

      const worker = new Worker(new URL("/__probe/bench-worker.js", location.href).href, {
        type: "module",
      });
      const wasmBase = new URL("/wasm/", location.href).href;

      const run = (parallel) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("逾時")), 30 * 60 * 1000);
          const handler = (ev) => {
            const d = ev.data || {};
            if (d.type === "bench-done") {
              clearTimeout(timer);
              worker.removeEventListener("message", handler);
              resolve(d);
            } else if (d.type === "error") {
              clearTimeout(timer);
              worker.removeEventListener("message", handler);
              reject(new Error(d.message));
            } else if (d.type === "status") {
              console.log(`  [${parallel}] ${d.message}`);
            }
          };
          worker.addEventListener("message", handler);
          worker.postMessage({
            type: "bench",
            base: wasmBase,
            modelUrl,
            pcm,
            parallel,
          });
        });

      try {
        const single = await run(0);
        let parallel = null;
        if (decoded.duration > 45) {
          parallel = await run(4);
        }
        return { ok: true, duration: decoded.duration, single, parallel };
      } catch (err) {
        return { ok: false, error: err?.message };
      } finally {
        worker.terminate();
      }
    },
    { modelUrl: "/__cache/models/breeze-q4_0.bin", audioUrl: `/__cache/audio/${audioName}` },
  );

  if (!result.ok) {
    console.error(`✗ ${result.error}`);
    process.exit(1);
  }

  const d = result.duration;
  const s = result.single;
  console.log(`\n音訊長度：${d.toFixed(2)} 秒`);
  console.log(`\n單段辨識（full_default）：`);
  console.log(`  耗時 ${(s.inferMs / 1000).toFixed(1)} 秒 → RTF ${(s.inferMs / 1000 / d).toFixed(2)}`);
  console.log(`  結果：${s.segments.map((x) => x.text).join(" ").slice(0, 100)}`);

  if (result.parallel) {
    const p = result.parallel;
    console.log(`\n平行辨識（full_parallel ×4）：`);
    console.log(`  耗時 ${(p.inferMs / 1000).toFixed(1)} 秒 → RTF ${(p.inferMs / 1000 / d).toFixed(2)}`);
    console.log(`  結果：${p.segments.map((x) => x.text).join(" ").slice(0, 100)}`);
    console.log(`\n加速比：${(s.inferMs / p.inferMs).toFixed(2)}×`);
  }
} finally {
  await browser.close();
  server.close();
}
