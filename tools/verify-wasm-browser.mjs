/**
 * 在真實瀏覽器（Chrome，cross-origin isolated）中載入 WASM 並驗證 embind API。
 *
 * 這是 WASM 能不能在網頁版真正跑起來的關鍵驗證：
 *   - 模組在 Worker 中初始化（pthread 版必須在支援 SharedArrayBuffer 的環境）
 *   - embind 匯出的函式都存在且可呼叫
 *   - 無效模型會優雅失敗（回傳 0），不是崩潰
 *
 * 用法：node tools/verify-wasm-browser.mjs
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { requireBrowser } from "./chrome.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");
const PORT = 4325;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".wasm": "application/wasm",
};

// tools/ 下的探針 Worker 也要能存取，因此 /__probe/ 映射到 tools/
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);

    let base = WEB;
    if (pathname.startsWith("/__probe/")) {
      base = join(ROOT, "tools");
      pathname = pathname.slice("/__probe".length);
    }
    if (pathname === "/") pathname = "/index.html";

    const target = normalize(join(base, pathname));
    if (!target.startsWith(base)) return res.writeHead(403).end();
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) return res.writeHead(404).end("not found");
    const body = await readFile(target);
    res.writeHead(200, {
      "Content-Type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
      "Content-Length": body.length,
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
});
await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));

const chrome = requireBrowser();
if (!chrome) {
  console.error("找不到 Chrome / Edge");
  process.exit(2);
}
console.log(`使用瀏覽器：${chrome}\n`);

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-features=SharedArrayBuffer"],
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  // 先載入頁面讓 coi-serviceworker 註冊並取得 cross-origin isolation
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => globalThis.crossOriginIsolated === true, {
    timeout: 30000,
    polling: 200,
  }).catch(() => {});
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);
  check("頁面取得 cross-origin isolation", isolated);

  const result = await page.evaluate(async () => {
    const wasmBase = new URL("/wasm/", location.href).href;
    const workerUrl = new URL("/__probe/wasm-probe-worker.js", location.href).href;
    const worker = new Worker(workerUrl, { type: "module" });

    const waitFor = (type, timeout = 180000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${type} 逾時`)), timeout);
        const handler = (ev) => {
          if (ev.data?.type === type) {
            clearTimeout(timer);
            worker.removeEventListener("message", handler);
            resolve(ev.data);
          } else if (ev.data?.type === "error") {
            clearTimeout(timer);
            worker.removeEventListener("message", handler);
            reject(new Error(ev.data.message));
          }
        };
        worker.addEventListener("message", handler);
      });

    try {
      worker.postMessage({ type: "init", base: wasmBase });
      const ready = await waitFor("ready");
      worker.postMessage({ type: "probe" });
      const probe = await waitFor("probe-result");
      return { ok: true, ready, probe };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    } finally {
      worker.terminate();
    }
  });

  if (!result.ok) {
    check("WASM 在 Worker 中載入", false, result.error);
  } else {
    check("WASM 在 Worker 中載入", true);
    check("Worker 內取得 cross-origin isolation", result.ready.isolated === true);

    const api = result.probe.api;
    const missing = Object.entries(api)
      .filter(([, t]) => t !== "function")
      .map(([n]) => n);
    check("embind API 全部可用", missing.length === 0, missing.join(", "));
    check("虛擬檔案系統可寫入", result.probe.fsOk === true, String(result.probe.fsOk).slice(0, 80));
    check(
      "無效模型優雅失敗（init 回傳 0）",
      result.probe.initRc === 0,
      `init() = ${JSON.stringify(result.probe.initRc)}`,
    );
    check("whisper.cpp 版本可讀", Boolean(result.probe.version), String(result.probe.version));
    check(
      "系統資訊可讀",
      Boolean(result.probe.systemInfo),
      String(result.probe.systemInfo || "").slice(0, 60),
    );
  }
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 項通過`);
if (failed.length) process.exit(1);
console.log("WASM 瀏覽器端驗證全部通過");
