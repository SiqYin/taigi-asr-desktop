/**
 * 跨平台的 Chrome / Edge 尋找器（供各測試腳本共用）。
 *
 * 優先順序：
 *   1. 環境變數 CHROME_PATH
 *   2. Puppeteer 常見安裝位置（PUPPETEER_CACHE_DIR）
 *   3. 各平台常見路徑（Windows / macOS / Linux，含 GitHub Actions runner）
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const WINDOWS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA || ""}/Google/Chrome/Application/chrome.exe`,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const MACOS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const LINUX = [
  // GitHub Actions ubuntu runner 預裝的 Chrome
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "/snap/bin/chromium",
];

function puppeteerCacheCandidates() {
  const roots = [
    process.env.PUPPETEER_CACHE_DIR,
    process.env.HOME ? join(process.env.HOME, ".cache", "puppeteer") : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "puppeteer") : null,
  ].filter(Boolean);

  const out = [];
  for (const root of roots) {
    for (const browser of ["chrome", "chrome-headless-shell"]) {
      // 版本目錄名不固定，交由呼叫端用 glob 展開；這裡只放常見的固定路徑
      out.push(join(root, browser));
    }
  }
  return out;
}

/** 回傳可用的瀏覽器執行檔路徑，找不到則回傳 null。 */
export function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    ...puppeteerCacheCandidates(),
    ...(process.platform === "win32" ? WINDOWS : []),
    ...(process.platform === "darwin" ? MACOS : []),
    ...(process.platform === "linux" ? LINUX : []),
  ].filter(Boolean);

  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

/** 找不到瀏覽器時印出可行動的錯誤訊息並結束行程。 */
export function requireBrowser() {
  const browser = findBrowser();
  if (!browser) {
    console.error(
      "找不到 Chrome / Edge。請安裝 Chrome，或設定環境變數 CHROME_PATH 指向瀏覽器執行檔。",
    );
    process.exit(2);
  }
  return browser;
}
