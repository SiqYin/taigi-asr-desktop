/* WASM 驗證用的 Worker（由 tools/verify-wasm-browser.mjs 載入）。
 *
 * 獨立成檔案而非 Blob 字串：頁面的 CSP 是 script-src 'self'，
 * Blob/字串 Worker 會被阻擋，而正式版 engine-worker.js 也是檔案形式。
 */

let factoryPromise = null;
let wasmBase = "";

async function getModule() {
  if (factoryPromise) return factoryPromise;
  factoryPromise = (async () => {
    const mod = await import(`${wasmBase}main.js`);
    const factory = mod.default;
    if (typeof factory !== "function") {
      throw new Error("main.js 未匯出工廠函式");
    }
    return factory({
      locateFile: (path) => `${wasmBase}${path}`,
      print: () => {},
      printErr: () => {},
    });
  })();
  return factoryPromise;
}

const API_NAMES = [
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

self.onmessage = async (event) => {
  const data = event.data || {};
  try {
    if (data.type === "init") {
      wasmBase = data.base;
      await getModule();
      self.postMessage({ type: "ready", isolated: self.crossOriginIsolated });
      return;
    }

    if (data.type === "probe") {
      const mod = await getModule();
      const api = {};
      for (const name of API_NAMES) api[name] = typeof mod[name];

      let fsOk = false;
      try {
        mod.FS_createDataFile("/", "probe.bin", new Uint8Array(512), true, true, true);
        fsOk = true;
      } catch (err) {
        fsOk = String(err);
      }

      let initRc = null;
      try {
        initRc = mod.init("probe.bin");
      } catch (err) {
        initRc = `threw:${err.message}`;
      }

      self.postMessage({
        type: "probe-result",
        api,
        fsOk,
        initRc,
        version: typeof mod.version === "function" ? mod.version() : null,
        systemInfo: typeof mod.system_info === "function" ? mod.system_info() : null,
      });
      return;
    }
  } catch (err) {
    self.postMessage({ type: "error", message: err?.message || String(err) });
  }
};
