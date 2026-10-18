/**
 * 在 Node 中直接載入建置好的 WASM，驗證：
 *   1. 模組可初始化（Emscripten 工廠函式可呼叫）
 *   2. embind 匯出的函式都存在
 *   3. 模型檔案可寫入虛擬檔案系統（用一個極小的假模型驗證 FS 路徑，
 *      不驗證推理結果——那需要真的 848 MB 模型）
 *
 * 用法：node tools/verify-wasm.mjs [--with-model <path-to-ggml.bin>]
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const WASM_DIR = join(ROOT, "web", "wasm");

const REQUIRED = [
  "init",
  "free",
  "is_multilingual",
  "full_default",
  "cancel",
  "full_n_segments",
  "full_get_segment_text",
  "full_get_segment_t0",
  "full_get_segment_t1",
  "full_n_tokens",
  "full_get_token_text",
  "full_get_token_t0",
  "full_get_token_t1",
  "version",
  "system_info",
];

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const jsPath = join(WASM_DIR, "main.js");
  const wasmPath = join(WASM_DIR, "main.wasm");

  if (!existsSync(jsPath) || !existsSync(wasmPath)) {
    console.error("找不到 WASM 產物，請先執行：bash web/wasm-src/build-wasm.sh");
    process.exit(2);
  }
  console.log(`main.js  : ${jsPath}`);
  console.log(`main.wasm: ${wasmPath}\n`);

  // Node 中沒有 Worker/SharedArrayBuffer 的瀏覽器語境，Emscripten 的
  // pthread 版本需要一些全域環境。先確認基本載入是否可行。
  // Windows 上動態 import 必須用 file:// URL。
  const module = await import(pathToFileURL(jsPath).href);
  const factory = module.default;
  check("main.js 匯出 Emscripten 工廠函式", typeof factory === "function");

  let instance;
  try {
    instance = await factory({
      locateFile: (path) => join(WASM_DIR, path),
      print: () => {},
      printErr: (text) => {
        const line = String(text);
        if (/error|failed/i.test(line)) console.error("  [wasm]", line.slice(0, 200));
      },
    });
  } catch (err) {
    check("WASM 初始化", false, err?.message || String(err));
    // 在 Node 環境中 pthread 版可能因缺少 Worker 支援而失敗，這不算致命：
    // 瀏覽器端（crossOriginIsolated）才是真實執行環境。
    console.log("\n注意：Node 缺少瀏覽器的 Worker/SharedArrayBuffer 語境，");
    console.log("      若因此失敗屬預期行為，瀏覽器端由 tools/e2e-web.mjs 驗證。");
    summarize();
    return;
  }

  check("WASM 初始化", true, `版本 ${instance.version?.() ?? "?"}`);

  const missing = REQUIRED.filter((fn) => typeof instance[fn] !== "function");
  check("embind 匯出的 API 齊全", missing.length === 0, missing.join(", "));

  if (typeof instance.system_info === "function") {
    const info = instance.system_info();
    check("whisper.cpp 系統資訊可讀", Boolean(info), String(info).slice(0, 80));
  }

  // 虛擬檔案系統可寫入（模型就是透過這個路徑載入的）
  try {
    const tiny = new Uint8Array(1024);
    instance.FS_createDataFile("/", "probe.bin", tiny, true, true, true);
    const exists = instance.FS_analyzePath?.("/probe.bin")?.exists ?? true;
    check("虛擬檔案系統可寫入模型", exists);
  } catch (err) {
    check("虛擬檔案系統可寫入模型", false, err?.message);
  }

  // 無效模型應優雅失敗（回傳 0），而不是讓程式崩潰
  try {
    const handle = instance.init("probe.bin");
    check("無效模型回傳 0（優雅失敗）", handle === 0, `init() = ${handle}`);
  } catch (err) {
    check("無效模型回傳 0（優雅失敗）", false, `拋出例外：${err?.message}`);
  }

  summarize();
}

function summarize() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 項通過`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
