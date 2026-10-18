/* 效能對比 Worker：同一段音訊分別用 full_default 與 full_parallel 跑，
 * 量測兩者的耗時差異，驗證平行處理是否真的有效。 */

let mod = null;
let handle = 0;
let modelUrl = "";
let modelLoaded = false;

async function ensureModel(base) {
  if (!mod) {
    mod = await import(`${base}main.js`).then((m) =>
      m.default({
        locateFile: (p) => `${base}${p}`,
        print: () => {},
        printErr: () => {},
      }),
    );
  }
  if (modelLoaded) return;

  const resp = await fetch(modelUrl);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  try {
    mod.FS_unlink("bench.bin");
  } catch {
    /* 不存在 */
  }
  mod.FS_createDataFile("/", "bench.bin", bytes, true, true, true);
  handle = mod.init("bench.bin");
  if (!handle) throw new Error("模型初始化失敗");
  modelLoaded = true;
}

function readSegments() {
  const count = mod.full_n_segments(handle) | 0;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const text = String(mod.full_get_segment_text(handle, i) || "").trim();
    if (!text) continue;
    out.push({
      start: (mod.full_get_segment_t0(handle, i) | 0) / 100,
      end: (mod.full_get_segment_t1(handle, i) | 0) / 100,
      text,
    });
  }
  return out;
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type !== "bench") return;

  try {
    modelUrl = data.modelUrl;
    self.postMessage({ type: "status", message: "載入模型…" });
    await ensureModel(data.base);

    const pcm = data.pcm;
    const ptr = mod._malloc(pcm.length * 4);
    if (!ptr) throw new Error("記憶體不足");
    mod.HEAPF32.set(pcm, ptr >> 2);

    let rc;
    const t0 = performance.now();
    if (data.parallel > 1) {
      self.postMessage({ type: "status", message: `平行辨識 ×${data.parallel}…` });
      rc = mod.full_parallel(handle, pcm.length, ptr, "zh", 5, false, data.parallel);
    } else {
      self.postMessage({ type: "status", message: "單段辨識…" });
      rc = mod.full_default(handle, pcm.length, ptr, "zh", 5, false);
    }
    const inferMs = performance.now() - t0;
    mod._free(ptr);

    if (rc !== 0) throw new Error(`辨識失敗，錯誤碼 ${rc}`);

    self.postMessage({
      type: "bench-done",
      parallel: data.parallel,
      inferMs,
      segments: readSegments(),
    });
  } catch (err) {
    self.postMessage({ type: "error", message: err?.message || String(err) });
  }
};
