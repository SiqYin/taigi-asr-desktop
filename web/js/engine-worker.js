/* 台語辨識 Worker：載入 whisper.cpp WebAssembly，跑 Breeze-ASR-26 模型。
 *
 * 為什麼放在 Worker：
 *   - WASM 初始化 + 推理會長時間佔用 CPU，放在主執行緒會讓 UI 卡死；
 *   - whisper.cpp 的 pthread 版（USE_PTHREADS=1）需要 SharedArrayBuffer
 *     （crossOriginIsolated），Worker 內同樣適用。
 *
 * WASM 以 ES module 工廠函式輸出（-sMODULARIZE=1 -sEXPORT_ES6=1），
 * 這樣 main.js 內部用 import.meta.url 定位 main.worker.js，
 * 不會像 global 版在 Worker 內誤判腳本路徑。
 *
 * 協定（postMessage）：
 *   in : { type: "load", base: "…/wasm/" }
 *        { type: "transcribe", id, pcm: Float32Array, language, beamSize, wordTimestamps }
 *        { type: "cancel", id }
 *   out: { type: "status", phase, message, fraction }
 *        { type: "ready", threads }
 *        { type: "native-progress", percent }
 *        { type: "progress", id, fraction, message }
 *        { type: "result", id, segments, duration }
 *        { type: "error", id?, message }
 *        { type: "cancelled", id }
 */

let factoryPromise = null;
let moduleRef = null;
let instanceHandle = 0;
const pending = new Map();

function post(message) {
  self.postMessage(message);
}

function status(phase, message, fraction = null) {
  post({ type: "status", phase, message, fraction });
}

function detectThreads() {
  const cores = navigator.hardwareConcurrency || 4;
  const isolated = self.crossOriginIsolated === true;
  if (!isolated) return 1;
  // 行動裝置保守取 4，避免過熱降頻；whisper.cpp 內部再夾在 8 以內。
  return Math.max(1, Math.min(4, Math.floor(cores / 2) || 1));
}

/** 載入並初始化 WASM 模組（只做一次）。 */
function loadModule(base) {
  if (factoryPromise) return factoryPromise;

  factoryPromise = (async () => {
    const url = new URL(`${base}main.js`, self.location.href).href;
    status("wasm", "載入 WebAssembly 執行環境…");

    let factory;
    try {
      factory = (await import(url)).default;
    } catch (err) {
      throw new Error(
        `無法載入 WASM 執行檔（${url}）：${err?.message || err}。` +
          "若這是第一次部署，請確認 GitHub Actions 的 web 工作流程已成功產出 web/wasm/main.js。",
      );
    }
    if (typeof factory !== "function") {
      throw new Error("WASM 模組格式不符：main.js 未匯出工廠函式");
    }

    const instance = await factory({
      // 讓 Emscripten 以 wasm/ 目錄為基準找 main.wasm / main.worker.js
      locateFile: (path) => new URL(`${base}${path}`, self.location.href).href,
      print: (text) => handleNativeLog(String(text)),
      printErr: (text) => handleNativeLog(String(text)),
    });

    moduleRef = instance;
    post({ type: "ready", threads: detectThreads() });
    return instance;
  })().catch((err) => {
    factoryPromise = null;
    throw err;
  });

  return factoryPromise;
}

/** 解析 whisper.cpp 的原生輸出，取出進度與錯誤訊息。 */
function handleNativeLog(line) {
  if (!line.trim()) return;
  const match = line.match(/progress\s*=\s*(\d+)\s*%/i);
  if (match) {
    post({ type: "native-progress", percent: Number(match[1]) });
  }
  if (/\berror\b|failed/i.test(line)) {
    post({ type: "native-log", message: line.slice(0, 300) });
  }
}

function writeModelToFs(fileName, bytes) {
  const mod = moduleRef;
  try {
    mod.FS_unlink(fileName);
  } catch {
    /* 檔案不存在 */
  }
  mod.FS_createDataFile("/", fileName, new Uint8Array(bytes), true, true, true);
}

async function handleLoad({ base, model, blob }) {
  const mod = await loadModule(base);

  let bytes;
  if (blob) {
    // 主執行緒已從 IndexedDB 取到快取模型，直接讀取，免重新下載。
    status("model", "讀取已快取的模型…", 1);
    bytes = new Uint8Array(await blob.arrayBuffer());
  } else {
    status("model", "下載辨識模型…", 0);
    const response = await fetch(model.url, { mode: "cors", credentials: "omit" });
    if (!response.ok) {
      throw new Error(`模型下載失敗（HTTP ${response.status}）`);
    }

    const total = Number(response.headers.get("content-length")) || model.bytes || 0;
    const reader = response.body?.getReader();

    if (reader) {
      const chunks = [];
      let received = 0;
      let lastEmit = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        const now = Date.now();
        if (now - lastEmit > 200) {
          lastEmit = now;
          const fraction = total ? received / total : null;
          status(
            "model",
            `下載模型… ${total ? ((received / total) * 100).toFixed(0) + "%" : Math.round(received / 1048576) + " MB"}`,
            fraction,
          );
        }
      }
      const merged = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      bytes = merged;
    } else {
      bytes = new Uint8Array(await response.arrayBuffer());
    }
  }

  status("model", "寫入 WASM 檔案系統…", 1);
  const fileName = `${model.id}.bin`;
  writeModelToFs(fileName, bytes);
  // 釋放參考，讓 GC 有機會回收這份 848 MB 的 JS 端副本。
  bytes = null;

  status("init", "初始化辨識器（首次約需數十秒）…", null);
  const handle = mod.init(fileName);
  if (!handle) {
    throw new Error("模型初始化失敗（檔案可能損毀，請清除瀏覽器資料後重新下載）");
  }
  instanceHandle = handle;

  status("ready", "模型就緒", 1);
  post({ type: "loaded", model: model.id });
}

function readSegments(handle, audioSeconds) {
  const mod = moduleRef;
  const count = mod.full_n_segments(handle) | 0;
  const out = [];
  // whisper 會把短音訊補零到 30 秒窗口，導致最後一句的結束時間超出實際音長
  // （例如 5.7 秒的音檔得到 31 秒的時間戳）。字幕若超出音訊長度，播放器會
  // 顯示空白或錯位，因此把結束時間鉗制在真實長度內。
  const limit = Number.isFinite(audioSeconds) && audioSeconds > 0 ? audioSeconds : Infinity;
  for (let i = 0; i < count; i += 1) {
    const text = String(mod.full_get_segment_text(handle, i) || "").trim();
    if (!text) continue;
    // 10 ms 單位 → 秒
    let start = (mod.full_get_segment_t0(handle, i) | 0) / 100;
    let end = (mod.full_get_segment_t1(handle, i) | 0) / 100;
    if (start >= limit) continue; // 整句都在音訊之外（補零區），丟棄
    if (end > limit) end = limit;
    if (end <= start) continue;
    out.push({ start, end, text });
  }
  return out;
}

function readWords(handle) {
  const mod = moduleRef;
  const count = mod.full_n_segments(handle) | 0;
  const words = [];
  for (let i = 0; i < count; i += 1) {
    const n = mod.full_n_tokens(handle, i) | 0;
    for (let t = 0; t < n; t += 1) {
      const text = String(mod.full_get_token_text(handle, i, t) || "");
      if (!text.trim()) continue;
      // 略過時間戳記與特殊 token
      if (/^<\|.*\|>$/.test(text)) continue;
      words.push({
        start: (mod.full_get_token_t0(handle, i, t) | 0) / 100,
        end: (mod.full_get_token_t1(handle, i, t) | 0) / 100,
        text,
      });
    }
  }
  return words;
}

async function handleTranscribe({ id, pcm, language = "zh", beamSize = 5, wordTimestamps = false }) {
  const mod = moduleRef;
  if (!mod || !instanceHandle) throw new Error("模型尚未載入");

  const nSamples = pcm.length;
  const ptr = mod._malloc(nSamples * 4);
  if (!ptr) throw new Error("WASM 記憶體不足，請改用較短的檔案或關閉其他分頁");

  try {
    mod.HEAPF32.set(pcm, ptr >> 2);
    post({ type: "progress", id, fraction: 0.02, message: "開始辨識…" });

    // 註：不使用 full_parallel —— 它在 Emscripten pthread 環境會因 C++ 例外
    // unwinding 而 abort。前端改為把長音訊切塊後逐塊呼叫 full_default。
    const rc = mod.full_default(instanceHandle, nSamples, ptr, language, beamSize, wordTimestamps);

    if (rc === -3) {
      post({ type: "cancelled", id });
      return;
    }
    if (rc !== 0) {
      throw new Error(`辨識失敗（錯誤碼 ${rc}）`);
    }

    const audioSeconds = nSamples / 16000;
    const segments = readSegments(instanceHandle, audioSeconds);
    const words = wordTimestamps ? readWords(instanceHandle) : [];
    const duration = segments.length ? segments[segments.length - 1].end : audioSeconds;
    post({ type: "result", id, segments, words, duration });
  } finally {
    try {
      mod._free(ptr);
    } catch {
      /* ignore */
    }
    pending.delete(id);
  }
}

self.onmessage = async (event) => {
  const data = event.data || {};
  try {
    switch (data.type) {
      case "load":
        await handleLoad(data);
        break;
      case "transcribe":
        pending.set(data.id, true);
        await handleTranscribe(data);
        break;
      case "cancel": {
        // 立刻呼叫原生取消：whisper.cpp 的 abort_callback 會在下次 ggml 計算前讀到。
        moduleRef?.cancel?.();
        if (!pending.has(data.id)) post({ type: "cancelled", id: data.id });
        break;
      }
      default:
        post({ type: "error", message: `未知指令：${data.type}` });
    }
  } catch (err) {
    post({ type: "error", id: data.id, message: err?.message || String(err) });
  }
};
