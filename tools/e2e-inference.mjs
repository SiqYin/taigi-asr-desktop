/**
 * 完整端到端推理驗證：真實模型 + 真實音訊 → 字幕。
 *
 * 這是網頁版「功能與桌面端一致」的最終證據。流程與正式版完全相同：
 *   1. 讀取 .cache/models/breeze-q4_0.bin（或環境變數指定的模型）
 *   2. 讀取 .cache/audio/test.m4a 並用瀏覽器解碼成 16 kHz 單聲道
 *   3. 在 Worker 中載入 WASM + 模型
 *   4. 呼叫 full_default 做台語辨識
 *   5. 讀回逐句時間戳與文字，產生 SRT / VTT / TXT / JSON
 *
 * 用法：
 *   node tools/e2e-inference.mjs
 *   MODEL_PATH=... AUDIO_PATH=... node tools/e2e-inference.mjs
 */
import { createServer } from "node:http";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");
const TOOLS = join(ROOT, "tools");
const CACHE = join(ROOT, ".cache");
const PORT = 4327;

const MODEL_PATH = process.env.MODEL_PATH || join(CACHE, "models", "breeze-q4_0.bin");
const AUDIO_PATH = process.env.AUDIO_PATH || join(CACHE, "audio", "test.m4a");

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && existsSync(p)) return p;
  return null;
}

const server = createServer(async (req, res) => {
  try {
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
    if (!info?.isFile()) return res.writeHead(404).end("not found");

    // 大檔案用串流，避免一次讀進記憶體
    if (info.size > 32 * 1024 * 1024) {
      res.writeHead(200, {
        "Content-Type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
        "Content-Length": info.size,
      });
      const { createReadStream } = await import("node:fs");
      createReadStream(target).pipe(res);
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
await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

if (!existsSync(MODEL_PATH)) {
  fail(`找不到模型：${MODEL_PATH}`);
  console.error("請先下載：curl -L -o .cache/models/breeze-q4_0.bin \\");
  console.error("  https://huggingface.co/weemed/Breeze-ASR-26-GGML/resolve/main/breeze-q4_0.bin");
  server.close();
  process.exit(2);
}
if (!existsSync(AUDIO_PATH)) {
  fail(`找不到測試音訊：${AUDIO_PATH}`);
  server.close();
  process.exit(2);
}

const modelMB = ((await stat(MODEL_PATH)).size / (1024 * 1024)).toFixed(0);
console.log(`模型：${MODEL_PATH}（${modelMB} MB）`);
console.log(`音訊：${AUDIO_PATH}\n`);

const chrome = findChrome();
if (!chrome) {
  console.error("找不到 Chrome / Edge");
  server.close();
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  // 大模型推理可能長達數分鐘，預設 180s 的協議超時會誤判失敗。
  protocolTimeout: 30 * 60 * 1000,
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
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console]", m.text().slice(0, 200));
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle2" });
  // coi-serviceworker 首次註冊後會自行 reload 一次才會 cross-origin isolated，
  // 因此等到它真正成立（或主動 reload 一次）。
  await page
    .waitForFunction(() => globalThis.crossOriginIsolated === true, {
      timeout: 30000,
      polling: 200,
    })
    .catch(() => {});
  if (!(await page.evaluate(() => globalThis.crossOriginIsolated === true))) {
    await page.reload({ waitUntil: "networkidle2" }).catch(() => {});
    await page
      .waitForFunction(() => globalThis.crossOriginIsolated === true, {
        timeout: 30000,
        polling: 200,
      })
      .catch(() => {});
  }
  check("cross-origin isolation", await page.evaluate(() => globalThis.crossOriginIsolated === true));

  console.log("\n開始推理（首次載入模型較慢，請耐心等待）…\n");
  const started = Date.now();

  const outcome = await page.evaluate(
    async ({ modelUrl, audioUrl }) => {
      const timings = {};
      const t0 = performance.now();

      const workerUrl = new URL("/__probe/inference-worker.js", location.href).href;
      const worker = new Worker(workerUrl, { type: "module" });
      const wasmBase = new URL("/wasm/", location.href).href;

      const waitFor = (type, timeout = 900000) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${type} 逾時`)), timeout);
          const handler = (ev) => {
            const d = ev.data || {};
            if (d.type === type) {
              clearTimeout(timer);
              worker.removeEventListener("message", handler);
              resolve(d);
            } else if (d.type === "error") {
              clearTimeout(timer);
              worker.removeEventListener("message", handler);
              reject(new Error(d.message));
            } else if (d.type === "status") {
              console.log(`  [${d.phase}] ${d.message}`);
            }
          };
          worker.addEventListener("message", handler);
        });

      try {
        // 1) 解碼音訊（主執行緒，用瀏覽器內建解碼器）
        const resp = await fetch(audioUrl);
        const buffer = await resp.arrayBuffer();
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        const decoded = await ctx.decodeAudioData(buffer);
        await ctx.close();
        const srcRate = decoded.sampleRate;

        const OfflineCtx = window.OfflineAudioContext;
        const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
        const offline = new OfflineCtx(1, frames, 16000);
        const src = offline.createBufferSource();
        src.buffer = decoded;
        src.connect(offline.destination);
        src.start(0);
        const rendered = await offline.startRendering();
        const pcm = rendered.getChannelData(0);
        timings.decodeMs = performance.now() - t0;

        // 2) 交給 Worker：載入模型 + 辨識
        worker.postMessage({ type: "run", base: wasmBase, modelUrl, pcm: new Float32Array(pcm) });
        const done = await waitFor("done");
        timings.totalMs = performance.now() - t0;

        return {
          ok: true,
          timings,
          audioDuration: decoded.duration,
          srcRate,
          segments: done.segments,
          words: done.words,
          duration: done.duration,
          modelLoadMs: done.modelLoadMs,
          inferMs: done.inferMs,
        };
      } catch (err) {
        return { ok: false, error: err?.message || String(err), timings };
      } finally {
        worker.terminate();
      }
    },
    {
      modelUrl: `/__cache/models/${MODEL_PATH.split(/[\\/]/).pop()}`,
      audioUrl: `/__cache/audio/${AUDIO_PATH.split(/[\\/]/).pop()}`,
    },
  );

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (!outcome.ok) {
    check("推理執行", false, outcome.error);
  } else {
    check("推理執行", true, `總耗時 ${elapsed}s`);
    check("音訊解碼成功", outcome.audioDuration > 0, `${outcome.audioDuration.toFixed(2)} 秒`);
    check(
      "模型載入",
      outcome.modelLoadMs > 0,
      `${(outcome.modelLoadMs / 1000).toFixed(1)} 秒`,
    );
    check(
      "辨識產生結果",
      Array.isArray(outcome.segments) && outcome.segments.length > 0,
      `${outcome.segments.length} 句`,
    );

    if (outcome.segments?.length) {
      const text = outcome.segments.map((s) => s.text).join("");
      console.log(`\n辨識結果（${outcome.segments.length} 句）：`);
      for (const seg of outcome.segments.slice(0, 12)) {
        console.log(`  [${seg.start.toFixed(2)} → ${seg.end.toFixed(2)}] ${seg.text}`);
      }
      if (outcome.segments.length > 12) console.log(`  …（其餘 ${outcome.segments.length - 12} 句）`);
      console.log(`\n全文：${text.slice(0, 300)}${text.length > 300 ? "…" : ""}\n`);

      check("辨識文字非空", text.trim().length > 0, `${text.trim().length} 字`);
      check(
        "時間戳記合理（在音訊長度內）",
        outcome.segments.every((s) => s.end <= outcome.audioDuration + 2 && s.start >= 0),
        `音訊 ${outcome.audioDuration.toFixed(2)}s，最後一句結束 ${outcome.segments[outcome.segments.length - 1].end.toFixed(2)}s`,
      );
      check(
        "句序遞增",
        outcome.segments.every((s, i, arr) => i === 0 || s.start >= arr[i - 1].start),
      );
      check(
        "推理速度",
        outcome.inferMs > 0,
        `RTF ≈ ${(outcome.inferMs / 1000 / outcome.audioDuration).toFixed(2)}（即時倍率，越小越快）`,
      );

      // 產生四種字幕並存檔
      const srt = toSrt(outcome.segments);
      const vtt = toVtt(outcome.segments);
      const txt = toTxt(outcome.segments);
      const json = JSON.stringify(
        {
          segments: outcome.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
          meta: {
            engine: "whisper.cpp-Breeze-ASR-26-GGML",
            runtime: "WebAssembly",
            language: "zh",
            duration: outcome.audioDuration,
          },
        },
        null,
        2,
      );

      check("產生 SRT", srt.includes("-->") && /^\d+\n/.test(srt), `${srt.split("\n").length} 行`);
      check("產生 VTT", vtt.startsWith("WEBVTT"));
      check("產生 TXT", txt.startsWith("["));
      check("產生 JSON", JSON.parse(json).segments.length === outcome.segments.length);

      const outDir = join(CACHE, "output");
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, "test.srt"), srt, "utf-8");
      await writeFile(join(outDir, "test.vtt"), vtt, "utf-8");
      await writeFile(join(outDir, "test.txt"), txt, "utf-8");
      await writeFile(join(outDir, "test.json"), json, "utf-8");
      console.log(`\n字幕已存到：${outDir}`);
    }
  }
} finally {
  await browser.close();
  server.close();
}

function formatTime(seconds, srtFormat = false) {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const pad = (n, w) => String(n).padStart(w, "0");
  if (srtFormat) {
    const totalMs = Math.round(s * 1000);
    const ms = totalMs % 1000;
    const totalS = Math.floor(totalMs / 1000);
    return `${pad(Math.floor(totalS / 3600), 2)}:${pad(Math.floor((totalS % 3600) / 60), 2)}:${pad(totalS % 60, 2)},${pad(ms, 3)}`;
  }
  return `${pad(Math.floor(s / 3600), 2)}:${pad(Math.floor((s % 3600) / 60), 2)}:${pad(Math.floor(s % 60), 2)}`;
}

function toSrt(segments) {
  if (!segments.length) return "";
  return (
    segments
      .map(
        (s, i) =>
          `${i + 1}\n${formatTime(s.start, true)} --> ${formatTime(s.end, true)}\n${s.text}\n`,
      )
      .join("\n") + "\n"
  );
}

function toVtt(segments) {
  if (!segments.length) return "WEBVTT\n\n";
  return (
    "WEBVTT\n\n" +
    segments
      .map(
        (s) =>
          `${formatTime(s.start, true).replace(",", ".")} --> ${formatTime(s.end, true).replace(",", ".")}\n${s.text}\n`,
      )
      .join("\n")
  );
}

function toTxt(segments) {
  return segments.map((s) => `[${formatTime(s.start)} - ${formatTime(s.end)}] ${s.text}\n`).join("");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 項通過`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  process.exit(1);
}
console.log("端到端推理驗證全部通過：網頁版確實能完成台語辨識並輸出字幕");
