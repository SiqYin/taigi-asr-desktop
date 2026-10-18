/**
 * 本機靜態伺服器：模擬 GitHub Pages 的靜態託管，方便開發與測試。
 *
 * 注意：這裡刻意「不」加上 COOP/COEP 標頭，以真實模擬 GitHub Pages 的環境
 * ——跨域隔離由 web/coi-serviceworker.js 在瀏覽器端注入，這正是部署後的實際行為。
 *
 * 用法：node tools/serve-web.mjs [--port 4319]
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");
const portArg = process.argv.indexOf("--port");
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 4319;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".vtt": "text/vtt; charset=utf-8",
  ".bin": "application/octet-stream",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname === "") pathname = "/index.html";
    if (pathname.endsWith("/")) pathname += "index.html";

    const target = normalize(join(WEB, pathname));
    if (!target.startsWith(WEB)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("403 forbidden");
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 not found");
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      "Content-Type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
      "Content-Length": body.length,
      // 靜態資源不快取，開發時改檔立刻生效
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(String(err));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`台語 ASR 網頁版：http://127.0.0.1:${PORT}/`);
  console.log(`服務目錄：${WEB}`);
  console.log("提示：首次開啟時 coi-serviceworker 會自動重新載入一次以啟用多執行緒。");
  if (!process.env.CI) {
    console.log("按 Ctrl+C 結束。");
  }
});
