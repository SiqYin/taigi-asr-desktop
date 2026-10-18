/**
 * 執行緒自檢：確認 WASM 的 pthread 是否真的能開多執行緒。
 * 這決定了網頁版速度——單執行緒會慢一個數量級。
 *
 * 用法：node tools/check-threads.mjs
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");
const TOOLS = join(ROOT, "tools");
const PORT = 4331;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  let base = WEB;
  if (pathname.startsWith("/__probe/")) {
    base = TOOLS;
    pathname = pathname.slice("/__probe".length);
  }
  if (pathname === "/") pathname = "/index.html";
  const target = normalize(join(base, pathname));
  if (!target.startsWith(base)) return res.writeHead(403).end();
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return res.writeHead(404).end("nf");
  const body = await readFile(target);
  res.writeHead(200, {
    "Content-Type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
    "Content-Length": body.length,
  });
  res.end(body);
});
await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (!existsSync(chrome)) {
  console.error("找不到 Chrome");
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  protocolTimeout: 5 * 60 * 1000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-features=SharedArrayBuffer"],
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console]", m.text().slice(0, 200));
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

  console.log("頁面 crossOriginIsolated =", await page.evaluate(() => globalThis.crossOriginIsolated));
  console.log("hardwareConcurrency =", await page.evaluate(() => navigator.hardwareConcurrency));
  console.log("SharedArrayBuffer =", await page.evaluate(() => typeof SharedArrayBuffer !== "undefined"));

  const result = await page.evaluate(async () => {
    const wasmBase = new URL("/wasm/", location.href).href;
    const workerUrl = new URL("/__probe/thread-diag-worker.js", location.href).href;
    const worker = new Worker(workerUrl, { type: "module" });

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: "逾時" }), 120000);
      worker.onmessage = (ev) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(ev.data);
      };
      worker.postMessage({ type: "diag", base: wasmBase });
    });
  });

  console.log("\n=== Worker 內診斷 ===");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  server.close();
}
