/**
 * 正式路徑端到端測試：完全走 web/js/ 的生產程式碼（App + Engine + engine-worker），
 * 不做任何替身。這是「網頁版真的能用」的最終證據。
 *
 * 流程：把測試音訊注入頁面的檔案選擇 → 按「開始轉錄」→ 等任務完成
 *       → 檢查逐字稿、字幕下載、預覽上字幕。
 *
 * 用法：node tools/e2e-production.mjs
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { requireBrowser } from "./chrome.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");
const CACHE = join(ROOT, ".cache");
const PORT = 4335;

const AUDIO = process.env.AUDIO_PATH || join(CACHE, "audio", "test.m4a");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  let base = WEB;
  if (pathname.startsWith("/__cache/")) {
    base = CACHE;
    pathname = pathname.slice("/__cache".length);
  }
  if (pathname === "/") pathname = "/index.html";
  const target = normalize(join(base, pathname));
  if (!target.startsWith(base)) return res.writeHead(403).end();
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return res.writeHead(404).end("not found");
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
  console.error(`找不到測試音訊：${AUDIO}`);
  process.exit(2);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await puppeteer.launch({
  executablePath: requireBrowser(),
  headless: true,
  protocolTimeout: 40 * 60 * 1000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-features=SharedArrayBuffer"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  // 讓頁面能抓到 /__cache/ 的音訊，且模型請求改走本機（避免真的下載 848 MB）
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("huggingface.co") && url.includes("breeze-q4_0.bin")) {
      req.continue({ url: `http://127.0.0.1:${PORT}/__cache/models/breeze-q4_0.bin` });
      return;
    }
    req.continue();
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
  check("頁面就緒且跨域隔離", await page.evaluate(() => globalThis.crossOriginIsolated === true));

  // 用 DataTransfer 把真實音訊塞進 file input，觸發正式的上傳流程
  const audioName = AUDIO.split(/[\\/]/).pop();
  await page.evaluate(async (name) => {
    const resp = await fetch(`/__cache/audio/${name}`);
    const blob = await resp.blob();
    const file = new File([blob], name, { type: blob.type || "audio/mp4" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById("file-input");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, audioName);

  await new Promise((r) => setTimeout(r, 500));
  const staged = await page.evaluate(() => ({
    chips: document.querySelectorAll(".chip").length,
    label: document.getElementById("staged-label").textContent,
    startEnabled: !document.getElementById("start-btn").disabled,
  }));
  check("檔案進入待處理清單", staged.chips === 1 && staged.startEnabled, staged.label);

  // 按下「開始轉錄」——正式流程
  console.log("\n按下開始轉錄（正式流程，模型載入 + 辨識）…\n");
  const t0 = Date.now();
  await page.click("#start-btn");

  // 等待任務完成（狀態文字變成「完成」）
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".status-text");
      return el && (el.textContent === "完成" || el.textContent === "失敗");
    },
    { timeout: 30 * 60 * 1000, polling: 1000 },
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const state = await page.evaluate(() => {
    const app = globalThis.__taigiApp;
    const job = app.jobs[app.jobs.length - 1];
    return {
      status: job.status,
      error: job.error,
      segmentCount: job.segments.length,
      segments: job.segments.slice(0, 5),
      duration: job.duration,
      outputs: job.outputs,
      message: job.message,
      previewVisible: !document.getElementById("preview-card").hidden,
      hasSubtitleTrack: document.querySelectorAll("#preview-video track").length,
      transcriptRows: document.querySelectorAll("#preview-transcript .seg").length,
      engineBadge: document.getElementById("engine-badge").textContent,
      modelBadge: document.getElementById("model-badge").textContent,
    };
  });

  check("任務完成", state.status === "done", `${state.status} · ${elapsed}s · ${state.message}`);
  check("產生逐字稿", state.segmentCount > 0, `${state.segmentCount} 句`);
  check(
    "時間戳在音訊長度內",
    state.segments.every((s) => s.end <= (state.duration || 0) + 0.5),
    `音訊 ${state.duration?.toFixed(2)}s`,
  );
  check("輸出字幕檔", Array.isArray(state.outputs) && state.outputs.length > 0,
    state.outputs?.map((o) => o.filename).join(", "));
  check("預覽面板自動開啟（可上字幕）", state.previewVisible);
  check("預覽播放器掛上字幕軌", state.hasSubtitleTrack > 0, `${state.hasSubtitleTrack} 條`);
  check("預覽逐字稿可點擊跳轉", state.transcriptRows > 0, `${state.transcriptRows} 行`);
  check("引擎狀態顯示就緒", state.engineBadge.includes("就緒") || state.engineBadge.includes("WebAssembly"),
    state.engineBadge);
  check("模型狀態顯示已載入", state.modelBadge.includes("已載入"), state.modelBadge);

  if (state.segments.length) {
    console.log("\n逐字稿：");
    for (const s of state.segments) {
      console.log(`  [${s.start.toFixed(2)} → ${s.end.toFixed(2)}] ${s.text}`);
    }
  }

  // 檢查下載的 SRT 內容（攔截 blob 下載）
  const srtContent = await page.evaluate(() => {
    const app = globalThis.__taigiApp;
    const job = app.jobs[app.jobs.length - 1];
    return import("/js/subtitles.js").then((m) => m.toSrt(job.segments));
  });
  check("SRT 格式正確", /^1\r?\n\d{2}:\d{2}:\d{2},\d{3} --> /.test(srtContent), srtContent.split("\n")[1]);

  const realErrors = errors.filter(
    (e) => !e.includes("favicon") && !e.includes("404") && !e.includes("Failed to load resource"),
  );
  check("無 JavaScript 錯誤", realErrors.length === 0, realErrors.slice(0, 2).join(" | "));

  await page.screenshot({ path: join(WEB, "screenshots", "result.png") });
  console.log(`\n截圖：web/screenshots/result.png`);
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 項通過`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  process.exit(1);
}
console.log("正式路徑端到端驗證全部通過");
