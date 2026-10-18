/**
 * 驗證模型快取機制（回歸測試）。
 *
 * 背景：先前實作讓 Worker 下載模型、主執行緒又下載一次以寫入 IndexedDB，
 * 首次使用會消耗兩倍流量（1.7 GB 而非 848 MB）。修復後由主執行緒
 * 統一下載一次、寫入快取，再把 Blob 交給 Worker。
 *
 * 本測試直接驗證快取層的行為：
 *   - 冷啟動（快取為空）→ 恰好發出 1 次下載
 *   - 熱啟動（已有快取）→ 0 次下載，直接回傳快取內容
 *
 * 用法：node tools/verify-model-cache.mjs
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { requireBrowser } from "./chrome.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");
const PORT = 4343;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
};

// 1 MB 假模型，避免測試真的下載 848 MB
const FAKE_MODEL = Buffer.alloc(1024 * 1024, 0x41);
let modelRequests = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/fake-model.bin") {
    modelRequests += 1;
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": FAKE_MODEL.length,
      "Access-Control-Allow-Origin": "*",
    });
    res.end(FAKE_MODEL);
    return;
  }

  if (pathname === "/") pathname = "/index.html";
  const target = normalize(join(WEB, pathname));
  if (!target.startsWith(WEB)) return res.writeHead(403).end();
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return res.writeHead(404).end("not found");
  const body = await readFile(target);
  res.writeHead(200, {
    "Content-Type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
    "Content-Length": body.length,
  });
  res.end(body);
});
await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));

const chrome = requireBrowser();
console.log(`使用瀏覽器：${chrome}\n`);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  protocolTimeout: 5 * 60 * 1000,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message.slice(0, 200)));

  // 只載入頁面取得同源環境，不需要跨域隔離（快取層與 COI 無關）
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

  // 清空 IndexedDB 以模擬首次使用
  await page.evaluate(async () => {
    const dbs = (await indexedDB.databases?.()) || [];
    await Promise.all(
      dbs.filter((d) => d.name).map(
        (d) =>
          new Promise((done) => {
            const req = indexedDB.deleteDatabase(d.name);
            req.onsuccess = req.onerror = req.onblocked = () => done();
          }),
      ),
    );
  });

  const modelUrl = `http://127.0.0.1:${PORT}/fake-model.bin`;

  // ---- 冷啟動 ----
  modelRequests = 0;
  const cold = await page.evaluate(
    async ({ url }) => {
      const cache = await import("/js/cache.js");
      const progress = [];
      const { blob, fromCache } = await cache.ensureModelBlob(
        "regression-test-model",
        url,
        1024 * 1024,
        { onProgress: (p) => progress.push({ ...p }) },
      );
      return { size: blob.size, fromCache, progressCount: progress.length };
    },
    { url: modelUrl },
  );

  check(
    "冷啟動恰好下載一次模型",
    modelRequests === 1,
    `實際 ${modelRequests} 次（修復前此路徑會是 1 次，但整體流程會變成 2 次）`,
  );
  check("冷啟動回傳完整內容", cold.size === 1024 * 1024, `${cold.size} bytes`);
  check("冷啟動標記為非快取來源", cold.fromCache === false);
  check("冷啟動有回報下載進度", cold.progressCount > 0, `${cold.progressCount} 次回報`);

  // ---- 熱啟動 ----
  modelRequests = 0;
  const warm = await page.evaluate(
    async ({ url }) => {
      const cache = await import("/js/cache.js");
      const { blob, fromCache } = await cache.ensureModelBlob(
        "regression-test-model",
        url,
        1024 * 1024,
        {},
      );
      return { size: blob.size, fromCache };
    },
    { url: modelUrl },
  );

  check("熱啟動不再發出任何下載請求", modelRequests === 0, `實際 ${modelRequests} 次`);
  check("熱啟動命中快取", warm.fromCache === true);
  check("熱啟動內容與原始一致", warm.size === 1024 * 1024, `${warm.size} bytes`);

  // ---- 靜態檢查：Worker 收到 blob 時不應再自行下載 ----
  const workerSrc = await readFile(join(WEB, "js", "engine-worker.js"), "utf-8");
  const blobBranch = workerSrc.match(/if \(blob\) \{([\s\S]*?)\n  \} else \{/);
  check("Worker 原始碼含 blob 分支", Boolean(blobBranch));
  if (blobBranch) {
    check(
      "Worker 收到 blob 時不發出網路請求",
      !blobBranch[1].includes("fetch("),
      blobBranch[1].includes("fetch(") ? "分支內仍含 fetch()" : "分支內無 fetch()",
    );
  }
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 項通過`);
if (failed.length) process.exit(1);
console.log("模型快取回歸測試通過：首次只下載一次，之後走快取");
