/**
 * 對「已部署的線上網站」做端到端驗證。
 *
 * 前面的測試都跑在本機伺服器；這支腳本直接打 GitHub Pages 上的正式網址，
 * 驗證真正交付出去的東西可用：
 *   - 頁面可載入、UI 完整
 *   - Service Worker 讓頁面取得 cross-origin isolation（多執行緒 WASM 前提）
 *   - WASM 產物可下載並在瀏覽器中初始化、embind API 齊全
 *   - 三種視窗尺寸（桌機／平板橫向／手機直向）版面無溢出
 *
 * 用法：node tools/verify-deployed-site.mjs [url]
 */
import puppeteer from "puppeteer-core";
import { requireBrowser } from "./chrome.mjs";

const SITE = process.argv[2] || "https://siqyin.github.io/taigi-asr-desktop/";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const chrome = requireBrowser();
console.log(`網站：${SITE}`);
console.log(`瀏覽器：${chrome}\n`);

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  protocolTimeout: 10 * 60 * 1000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-features=SharedArrayBuffer"],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.setViewport({ width: 1440, height: 900 });
  const resp = await page.goto(SITE, { waitUntil: "networkidle2", timeout: 60000 });
  // 304 = Not Modified，快取命中，同樣代表可用
  check("網站可載入", [200, 304].includes(resp?.status()), `HTTP ${resp?.status()}`);

  // coi-serviceworker 首次註冊後會自行 reload 一次
  await page
    .waitForFunction(() => globalThis.crossOriginIsolated === true, { timeout: 45000, polling: 300 })
    .catch(() => {});
  if (!(await page.evaluate(() => globalThis.crossOriginIsolated === true))) {
    await page.reload({ waitUntil: "networkidle2" });
    await page
      .waitForFunction(() => globalThis.crossOriginIsolated === true, { timeout: 45000, polling: 300 })
      .catch(() => {});
  }
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);
  check("跨域隔離生效（多執行緒 WASM 前提）", isolated);
  check(
    "SharedArrayBuffer 可用",
    await page.evaluate(() => typeof SharedArrayBuffer !== "undefined"),
  );

  const ui = await page.evaluate(() => {
    const ids = ["engine-badge", "model-badge", "dropzone", "start-btn", "jobs", "capability-note"];
    return {
      missing: ids.filter((id) => !document.getElementById(id)),
      appReady: typeof globalThis.__taigiApp === "object",
      title: document.title,
    };
  });
  check("主要 UI 元件齊全", ui.missing.length === 0, ui.missing.join(", "));
  check("應用程式初始化", ui.appReady);

  // 用「正式路徑」驗證 WASM：透過應用自己的 engine-worker.js 載入。
  //
  // 為什麼不在主執行緒直接 import：頁面帶有 CSP（script-src 'self'
  // 'wasm-unsafe-eval'），Emscripten 的 glue 在主執行緒會用到 new Function
  // 而被 CSP 擋下；正式版本是在 Worker 內載入，Worker 有獨立的 CSP 環境。
  // 因此必須照正式路徑驗證，否則測到的不是使用者實際遇到的情況。
  //
  // 這裡故意傳一個不存在的模型網址：WASM 初始化成功後才會去抓模型，
  // 因此收到「模型下載失敗」即證明 WASM 已在 Worker 中成功初始化。
  const workerProbe = await page.evaluate(async () => {
    const base = new URL("wasm/", location.href).href;
    const workerUrl = new URL("js/engine-worker.js", location.href).href;
    const worker = new Worker(workerUrl, { type: "module" });

    return await new Promise((resolve) => {
      const statuses = [];
      const timer = setTimeout(
        () => resolve({ outcome: "timeout", statuses }),
        180000,
      );
      worker.onmessage = (ev) => {
        const d = ev.data || {};
        if (d.type === "status") {
          statuses.push(d.message || d.phase || "");
          return;
        }
        if (d.type === "error") {
          clearTimeout(timer);
          resolve({ outcome: "error", message: d.message, statuses });
        }
      };
      worker.onerror = (e) => {
        clearTimeout(timer);
        resolve({ outcome: "workererror", message: e.message, statuses });
      };
      worker.postMessage({
        type: "load",
        base,
        model: {
          id: "probe",
          // 不存在的檔案：用來區分「WASM 失敗」與「模型失敗」
          url: new URL("nonexistent-model-probe.bin", location.href).href,
          bytes: 1,
        },
      });
    });
  });

  const msg = String(workerProbe.message || "");
  const wasmOk =
    workerProbe.outcome === "error" &&
    (msg.includes("模型下載失敗") || msg.includes("HTTP 404")) &&
    !msg.includes("無法載入 WASM");
  check(
    "線上一 WASM 可在應用 Worker 中初始化",
    wasmOk,
    wasmOk ? `（如預期地在模型階段失敗：${msg.slice(0, 60)}）` : `${workerProbe.outcome}: ${msg.slice(0, 160)}`,
  );
  if (workerProbe.statuses?.length) {
    check(
      "Worker 回報 WASM 載入階段",
      workerProbe.statuses.some((s) => s.includes("WebAssembly")),
      workerProbe.statuses.slice(0, 3).join(" / "),
    );
  }

  // 三種視窗尺寸
  const viewports = [
    { name: "桌機 1440x900", width: 1440, height: 900, mobile: false },
    { name: "平板橫向 1180x820", width: 1180, height: 820, mobile: true },
    { name: "手機直向 390x844", width: 390, height: 844, mobile: true },
  ];
  for (const vp of viewports) {
    await page.setViewport({
      width: vp.width,
      height: vp.height,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      deviceScaleFactor: vp.mobile ? 2 : 1,
    });
    await new Promise((r) => setTimeout(r, 400));
    const layout = await page.evaluate(() => {
      const doc = document.documentElement;
      const cols = getComputedStyle(document.querySelector(".layout")).gridTemplateColumns;
      const btn = document.getElementById("start-btn")?.getBoundingClientRect();
      return {
        overflow: doc.scrollWidth - doc.clientWidth,
        columnCount: cols.split(" ").filter(Boolean).length,
        startVisible: btn ? btn.width > 0 && btn.height > 0 : false,
      };
    });
    check(
      `${vp.name}：版面無溢出`,
      layout.overflow <= 1,
      `溢出 ${layout.overflow}px，欄數 ${layout.columnCount}`,
    );
    check(`${vp.name}：開始按鈕可見`, layout.startVisible);
  }

  const realErrors = errors.filter(
    (e) => !e.includes("favicon") && !e.includes("Failed to load resource: the server responded with a status of 404"),
  );
  check("無 JavaScript 錯誤", realErrors.length === 0, realErrors.slice(0, 2).join(" | "));

  await page.setViewport({ width: 1440, height: 900 });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: "web/screenshots/deployed-site.png" }).catch(() => {});
  console.log("\n截圖：web/screenshots/deployed-site.png");
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 項通過`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  process.exit(1);
}
console.log("線上網站驗證全部通過");
