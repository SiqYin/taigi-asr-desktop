/* 效能剖析 Worker：把 whisper.cpp 的初始化與推理拆開量測，
 * 並比較不同 beam_size / n_threads 的效果，找出瀏覽器端的真實瓶頸。 */

let mod = null;
let handle = 0;

function log(message) {
  self.postMessage({ type: "status", message });
}

async function setup(base, modelUrl) {
  const t0 = performance.now();
  mod = await import(`${base}main.js`).then((m) =>
    m.default({
      locateFile: (p) => `${base}${p}`,
      print: () => {},
      printErr: () => {},
    }),
  );
  const wasmInitMs = performance.now() - t0;

  const t1 = performance.now();
  const resp = await fetch(modelUrl);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const downloadMs = performance.now() - t1;

  const t2 = performance.now();
  try {
    mod.FS_unlink("profile.bin");
  } catch {
    /* 不存在 */
  }
  mod.FS_createDataFile("/", "profile.bin", bytes, true, true, true);
  const fsMs = performance.now() - t2;

  const t3 = performance.now();
  handle = mod.init("profile.bin");
  if (!handle) throw new Error("模型初始化失敗");
  const initMs = performance.now() - t3;

  return {
    wasmInitMs,
    downloadMs,
    fsMs,
    initMs,
    modelMB: Math.round(bytes.length / 1048576),
    threadConfig: typeof mod.thread_config === "function" ? mod.thread_config() : null,
    systemInfo: typeof mod.system_info === "function" ? mod.system_info() : null,
    selftest: typeof mod.thread_selftest === "function" ? mod.thread_selftest() : null,
  };
}

function decode(pcm) {
  const ptr = mod._malloc(pcm.length * 4);
  mod.HEAPF32.set(pcm, ptr >> 2);
  return ptr;
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type !== "profile") return;

  try {
    log("初始化 WASM 與模型…");
    const setupInfo = await setup(data.base, data.modelUrl);
    log(`就緒：${JSON.stringify(setupInfo)}`);

    // PCM 由主執行緒解碼後傳入（Web Audio API 在 Worker 中不可用）
    const pcm = data.pcm;
    if (!pcm || !pcm.length) throw new Error("沒有收到音訊資料");

    const runs = [];

    // 比較不同 beam_size（固定模型，同一段音訊）
    for (const beam of [1, 5]) {
      log(`測試 beam_size=${beam}…`);
      const ptr = decode(pcm);
      const t = performance.now();
      const rc = mod.full_default(handle, pcm.length, ptr, "zh", beam, false);
      const ms = performance.now() - t;
      mod._free(ptr);

      const count = mod.full_n_segments(handle) | 0;
      const texts = [];
      for (let i = 0; i < count; i += 1) {
        texts.push(String(mod.full_get_segment_text(handle, i) || "").trim());
      }
      runs.push({ beam, rc, ms: Math.round(ms), texts: texts.filter(Boolean) });
    }

    self.postMessage({
      type: "profile-done",
      setupInfo,
      audioDuration: data.audioDuration,
      runs,
    });
  } catch (err) {
    self.postMessage({ type: "error", message: err?.message || String(err) });
  }
};
