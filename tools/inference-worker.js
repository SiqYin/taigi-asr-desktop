/* 端到端推理測試用的 Worker：載入真實模型並跑一次完整辨識。
 * 由 tools/e2e-inference.mjs 載入。
 */

let factoryPromise = null;
let wasmBase = "";
let instance = null;

async function getModule() {
  if (factoryPromise) return factoryPromise;
  factoryPromise = (async () => {
    const mod = await import(`${wasmBase}main.js`);
    const factory = mod.default;
    return factory({
      locateFile: (path) => `${wasmBase}${path}`,
      print: (text) => {
        const line = String(text);
        if (/error|failed/i.test(line)) {
          self.postMessage({ type: "status", phase: "wasm", message: line.slice(0, 200) });
        }
      },
      printErr: () => {},
    });
  })();
  return factoryPromise;
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type !== "run") return;

  try {
    wasmBase = data.base;
    const mod = await getModule();
    instance = mod;

    // 下載模型並寫入虛擬檔案系統
    self.postMessage({ type: "status", phase: "model", message: "下載模型…" });
    const tModel = performance.now();
    const resp = await fetch(data.modelUrl);
    if (!resp.ok) throw new Error(`模型下載失敗 HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    self.postMessage({ type: "status", phase: "model", message: `模型 ${(bytes.length / 1048576).toFixed(0)} MB，寫入虛擬檔案系統…` });

    const modelName = "model.bin";
    try {
      mod.FS_unlink(modelName);
    } catch {
      /* 不存在 */
    }
    mod.FS_createDataFile("/", modelName, bytes, true, true, true);

    self.postMessage({ type: "status", phase: "init", message: "初始化辨識器（大型模型，需數十秒）…" });
    const handle = mod.init(modelName);
    if (!handle) throw new Error("模型初始化失敗");
    const modelLoadMs = performance.now() - tModel;
    self.postMessage({ type: "status", phase: "init", message: `模型就緒（${(modelLoadMs / 1000).toFixed(1)}s）` });

    // 診斷：回報執行緒環境
    self.postMessage({
      type: "status",
      phase: "diag",
      message: `isolated=${self.crossOriginIsolated} sab=${typeof SharedArrayBuffer !== "undefined"} cores=${navigator.hardwareConcurrency} pthreads=${typeof mod.PThread !== "undefined"}`,
    });

    // 辨識
    self.postMessage({ type: "status", phase: "infer", message: "台語辨識中…" });
    const tInfer = performance.now();
    const pcm = data.pcm;
    const ptr = mod._malloc(pcm.length * 4);
    if (!ptr) throw new Error("WASM 記憶體不足");
    mod.HEAPF32.set(pcm, ptr >> 2);

    const rc = mod.full_default(handle, pcm.length, ptr, "zh", 5, false);
    const inferMs = performance.now() - tInfer;
    mod._free(ptr);

    if (rc !== 0) throw new Error(`辨識失敗，錯誤碼 ${rc}`);

    // 與正式版（web/js/engine-worker.js）相同的時間戳鉗制：
    // whisper 會把短音訊補零到 30 秒窗口，導致結束時間超出真實音長。
    const audioSeconds = pcm.length / 16000;
    const count = mod.full_n_segments(handle) | 0;
    const segments = [];
    for (let i = 0; i < count; i += 1) {
      const text = String(mod.full_get_segment_text(handle, i) || "").trim();
      if (!text) continue;
      let start = (mod.full_get_segment_t0(handle, i) | 0) / 100;
      let end = (mod.full_get_segment_t1(handle, i) | 0) / 100;
      if (start >= audioSeconds) continue;
      if (end > audioSeconds) end = audioSeconds;
      if (end <= start) continue;
      segments.push({ start, end, text });
    }

    self.postMessage({
      type: "done",
      segments,
      words: [],
      duration: audioSeconds,
      modelLoadMs,
      inferMs,
    });
  } catch (err) {
    self.postMessage({ type: "error", message: err?.message || String(err) });
  }
};
