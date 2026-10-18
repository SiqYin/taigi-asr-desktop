/** 診斷 coi-serviceworker 為何沒有讓頁面變成 cross-origin isolated。 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");
const PORT = 4321;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const target = normalize(join(WEB, pathname));
  if (!target.startsWith(WEB)) return res.writeHead(403).end();
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return res.writeHead(404).end("nf");
  const body = await readFile(target);
  res.writeHead(200, { "Content-Type": MIME[extname(target)] || "application/octet-stream" });
  res.end(body);
});
await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
page.on("console", (m) => console.log(`[${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 3000));

const state1 = await page.evaluate(async () => {
  const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
  return {
    hasSw: Boolean(navigator.serviceWorker),
    controller: Boolean(navigator.serviceWorker?.controller),
    registrations: regs.map((r) => ({
      scope: r.scope,
      active: r.active?.scriptURL,
      installing: r.installing?.scriptURL,
      waiting: r.waiting?.scriptURL,
    })),
    isolated: crossOriginIsolated,
    secure: isSecureContext,
    session: { ...sessionStorage },
  };
});
console.log("第一次載入：", JSON.stringify(state1, null, 2));

await page.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2500));
const state2 = await page.evaluate(() => ({
  controller: Boolean(navigator.serviceWorker?.controller),
  isolated: crossOriginIsolated,
  session: { ...sessionStorage },
}));
console.log("重新載入後：", JSON.stringify(state2, null, 2));

const headers = await page.evaluate(async () => {
  const res = await fetch("/index.html");
  return {
    coep: res.headers.get("cross-origin-embedder-policy"),
    coop: res.headers.get("cross-origin-opener-policy"),
    corp: res.headers.get("cross-origin-resource-policy"),
  };
});
console.log("回應標頭（經 SW 後）：", JSON.stringify(headers, null, 2));

await browser.close();
server.close();
