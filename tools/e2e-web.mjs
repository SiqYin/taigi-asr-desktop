/**
 * 網頁版端到端驗證（用本機 Chrome 跑無頭瀏覽器）。
 *
 * 檢查項目：
 *   1. 靜態伺服器可正常提供 web/（含 COOP/COEP 由 Service Worker 注入）
 *   2. 頁面無 JS 錯誤載入，主要 UI 元件都在
 *   3. crossOriginIsolated / SharedArrayBuffer / WASM SIMD 狀態
 *   4. 桌面、手機直向、手機橫向、平板橫向四種視窗尺寸下版面不溢出
 *   5. 字幕格式在瀏覽器端輸出正確
 *
 * 用法：node tools/e2e-web.mjs [--headed]
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");
const PORT = 4319;

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".vtt": "text/vtt; charset=utf-8",
  ".svg": "image/svg+xml",
};

function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/") pathname = "/index.html";
      const target = normalize(join(WEB, pathname));
      if (!target.startsWith(WEB)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const info = await stat(target).catch(() => null);
      if (!info || !info.isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
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
  return new Promise((ok) => server.listen(PORT, "127.0.0.1", () => ok(server)));
}

const VIEWPORTS = [
  { name: "桌面 1440x900", width: 1440, height: 900, isMobile: false, hasTouch: false },
  { name: "筆電 1280x800", width: 1280, height: 800, isMobile: false, hasTouch: false },
  { name: "平板橫向 1180x820", width: 1180, height: 820, isMobile: true, hasTouch: true },
  { name: "平板直向 820x1180", width: 820, height: 1180, isMobile: true, hasTouch: true },
  { name: "手機橫向 844x390", width: 844, height: 390, isMobile: true, hasTouch: true },
  { name: "手機直向 390x844", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "小手機 360x640", width: 360, height: 640, isMobile: true, hasTouch: true },
];

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error("找不到 Chrome / Edge，無法執行端到端驗證");
    process.exit(2);
  }
  console.log(`使用瀏覽器：${chrome}`);

  const server = await startServer();
  const headed = process.argv.includes("--headed");
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: !headed,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--allow-insecure-localhost",
      // 允許 Service Worker 在 127.0.0.1 上運作（安全來源）
      "--enable-features=SharedArrayBuffer",
    ],
  });

  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
    });

    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle2", timeout: 30000 });

    // coi-serviceworker 第一次註冊後會自行 reload 一次以取得 crossOriginIsolated，
    // 這裡等到 reload 真正發生、模組初始化完成，避免抓到 reload 前的舊頁面。
    await page.evaluate(() => {
      window.__taigiReloaded = false;
      window.addEventListener("beforeunload", () => {
        window.__taigiReloaded = true;
      });
    }).catch(() => {});
    await page.waitForFunction(
      () => globalThis.crossOriginIsolated === true && typeof globalThis.__taigiApp === "object",
      { timeout: 30000, polling: 250 },
    ).catch(() => {});

    // 若尚未隔離，主動 reload 一次再等
    const isolatedFirst = await page.evaluate(() => globalThis.crossOriginIsolated === true);
    if (!isolatedFirst) {
      await page.reload({ waitUntil: "networkidle2" }).catch(() => {});
      await page.waitForFunction(
        () => globalThis.crossOriginIsolated === true && typeof globalThis.__taigiApp === "object",
        { timeout: 30000, polling: 250 },
      ).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 800));

    // ---- 基本 UI ----
    const ui = await page.evaluate(() => {
      const ids = [
        "engine-badge", "model-badge", "dropzone", "file-input", "start-btn",
        "jobs", "quality", "model-select", "preview-card", "capability-note",
      ];
      const missing = ids.filter((id) => !document.getElementById(id));
      return {
        missing,
        title: document.title,
        caps: {
          isolated: globalThis.crossOriginIsolated === true,
          sab: typeof SharedArrayBuffer !== "undefined",
          cores: navigator.hardwareConcurrency,
        },
        hasModule: typeof globalThis.__taigiApp === "object",
      };
    });

    check("頁面載入且主要 UI 元件齊全", ui.missing.length === 0, ui.missing.join(", "));
    check("標題正確", ui.title.includes("台語"), ui.title);
    check("應用程式初始化成功", ui.hasModule);
    check(
      "跨域隔離（多執行緒 WASM 前提）",
      ui.caps.isolated && ui.caps.sab,
      `crossOriginIsolated=${ui.caps.isolated}, SharedArrayBuffer=${ui.caps.sab}`,
    );

    // ---- WASM SIMD ----
    const simd = await page.evaluate(() =>
      WebAssembly.validate(
        new Uint8Array([
          0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0,
          65, 0, 253, 15, 253, 98, 11,
        ]),
      ),
    );
    check("瀏覽器支援 WASM SIMD", simd);

    // ---- 字幕格式（瀏覽器端實跑） ----
    const subtitles = await page.evaluate(async () => {
      const mod = await import("/js/subtitles.js");
      const segs = [
        { start: 0, end: 1.5, text: "台語" },
        { start: 1.5, end: 3.25, text: "第二句" },
      ];
      return {
        srt: mod.toSrt(segs),
        vtt: mod.toVtt(segs),
        txt: mod.toTxt(segs),
        json: mod.toJson(segs, { beam_size: new mod.PyInt(5), duration: 3.25 }),
        clock: mod.formatClock(3725),
      };
    });
    check("瀏覽器端 SRT 輸出", subtitles.srt.includes("00:00:00,000 --> 00:00:01,500"), subtitles.srt.split("\n")[1]);
    check("瀏覽器端 VTT 輸出", subtitles.vtt.startsWith("WEBVTT"));
    check("瀏覽器端 TXT 輸出", subtitles.txt.startsWith("[00:00:00 - 00:00:01]"));
    check("瀏覽器端 JSON 為 Python 風格浮點", subtitles.json.includes('"duration": 3.25') && subtitles.json.includes('"beam_size": 5'));
    check("時間顯示格式", subtitles.clock === "1:02:05", subtitles.clock);

    // ---- 音訊分塊 ----
    const windows = await page.evaluate(async () => {
      const mod = await import("/js/audio.js");
      const rate = 16000;
      const pcm = new Float32Array(rate * 900);
      // 前 700 秒有聲音，之後靜音，模擬切點
      for (let i = 0; i < rate * 700; i += 1) pcm[i] = Math.sin(i / 20) * 0.3;
      return mod.planWindows(pcm, rate);
    });
    check("長音訊分塊計算", Array.isArray(windows) && windows.length >= 3, `共 ${windows.length} 段`);

    // ---- 響應式：逐一視窗尺寸檢查溢出 ----
    for (const vp of VIEWPORTS) {
      await page.setViewport({
        width: vp.width,
        height: vp.height,
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
        deviceScaleFactor: vp.isMobile ? 2 : 1,
      });
      await new Promise((r) => setTimeout(r, 450));
      const layout = await page.evaluate(() => {
        const doc = document.documentElement;
        const overflowX = doc.scrollWidth - doc.clientWidth;
        const layoutEl = document.querySelector(".layout");
        const style = layoutEl ? getComputedStyle(layoutEl) : null;
        const cols = style ? style.gridTemplateColumns : "";
        const startBtn = document.getElementById("start-btn");
        const rect = startBtn?.getBoundingClientRect();
        const stagedHead = document.querySelector(".staged-head");
        const stagedStyle = stagedHead ? getComputedStyle(stagedHead) : null;
        return {
          overflowX,
          columns: cols,
          columnCount: cols ? cols.split(" ").filter(Boolean).length : 0,
          startVisible: rect ? rect.width > 0 && rect.height > 0 : false,
          startInViewport: rect ? rect.top >= -1 && rect.bottom <= window.innerHeight + 1 : false,
          stagedFixed: stagedStyle ? stagedStyle.position === "fixed" : false,
          dropzoneWidth: document.getElementById("dropzone")?.getBoundingClientRect().width || 0,
        };
      });

      const noOverflow = layout.overflowX <= 1;
      check(`${vp.name}：無水平溢出`, noOverflow, `溢出 ${layout.overflowX}px，欄數 ${layout.columnCount}`);

      if (vp.isMobile && vp.width < 700) {
        check(
          `${vp.name}：開始轉錄按鈕固定可見`,
          layout.stagedFixed && layout.startVisible,
          `fixed=${layout.stagedFixed}, visible=${layout.startVisible}`,
        );
      } else {
        check(`${vp.name}：開始按鈕可見`, layout.startVisible);
      }

      if (vp.width >= 1024) {
        check(`${vp.name}：桌面雙欄`, layout.columnCount === 2, layout.columns);
      } else if (vp.height <= 620 && vp.width >= 700) {
        check(`${vp.name}：短高度橫向雙欄`, layout.columnCount === 2, layout.columns);
      } else {
        check(`${vp.name}：窄螢幕單欄`, layout.columnCount === 1, layout.columns);
      }
    }

    // ---- 加入檔案流程（用假的 File 物件模擬拖放） ----
    await page.setViewport({ width: 1440, height: 900 });
    await new Promise((r) => setTimeout(r, 300));
    const staged = await page.evaluate(async () => {
      const app = globalThis.__taigiApp;
      const file = new File([new Uint8Array(1024)], "測試影片.mp4", { type: "video/mp4" });
      app.addStaged([file]);
      const chips = document.querySelectorAll(".chip").length;
      const startDisabled = document.getElementById("start-btn").disabled;
      const label = document.getElementById("staged-label").textContent;
      return { chips, startDisabled, label };
    });
    check("加入檔案後出現在待處理清單", staged.chips === 1, staged.label);
    check("加入檔案後「開始轉錄」可用", staged.startDisabled === false);

    // ---- 任務列表渲染 ----
    const jobRender = await page.evaluate(() => {
      const app = globalThis.__taigiApp;
      const file = new File([new Uint8Array(64)], "demo.mp4", { type: "video/mp4" });
      const job = app.createJob(file);
      app.updateJob(job, {
        status: "done",
        progress: 1,
        segments: [{ start: 0, end: 1, text: "測試句子" }],
        duration: 1,
        message: "完成（1 句）",
      });
      const node = document.querySelector(".job");
      return {
        exists: Boolean(node),
        statusText: document.querySelector(".status-text")?.textContent,
        hasPreviewBtn: [...document.querySelectorAll(".job-actions button")].some((b) =>
          b.textContent.includes("預覽"),
        ),
      };
    });
    check("任務卡片渲染", jobRender.exists && jobRender.statusText === "完成", jobRender.statusText);
    check("完成任務有預覽／上字幕按鈕", jobRender.hasPreviewBtn);

    // ---- 關鍵錯誤 ----
    const realErrors = errors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("Failed to load resource: the server responded with a status of 404"),
    );
    check("無 JavaScript 執行錯誤", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

    // ---- 截圖 ----
    const shots = [
      { name: "desktop", width: 1440, height: 900, mobile: false },
      { name: "tablet-landscape", width: 1180, height: 820, mobile: true },
      { name: "phone-portrait", width: 390, height: 844, mobile: true },
      { name: "phone-landscape", width: 844, height: 390, mobile: true },
    ];
    const shotDir = join(ROOT, "web", "screenshots");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(shotDir, { recursive: true });
    for (const shot of shots) {
      await page.setViewport({
        width: shot.width,
        height: shot.height,
        isMobile: shot.mobile,
        hasTouch: shot.mobile,
        deviceScaleFactor: shot.mobile ? 2 : 1,
      });
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: join(shotDir, `${shot.name}.png`), fullPage: false });
      console.log(`  → 截圖 web/screenshots/${shot.name}.png`);
    }
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 項通過`);
  if (failed.length) {
    console.log("失敗項目：");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
    process.exit(1);
  }
  console.log("網頁版端到端驗證全部通過");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
