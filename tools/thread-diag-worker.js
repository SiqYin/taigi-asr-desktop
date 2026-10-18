/* 執行緒診斷 Worker：確認 WASM 是否真的能開 pthread。 */

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type !== "diag") return;

  const info = {
    isolated: self.crossOriginIsolated,
    sab: typeof SharedArrayBuffer !== "undefined",
    cores: navigator.hardwareConcurrency,
  };

  try {
    const mod = await import(`${data.base}main.js`).then((m) =>
      m.default({
        locateFile: (p) => `${data.base}${p}`,
        print: () => {},
        printErr: () => {},
      }),
    );

    // 模組層面
    info.hasPThread = typeof mod.PThread !== "undefined";
    info.hasMalloc = typeof mod._malloc === "function";
    info.heapIsShared = mod.HEAPU8?.buffer instanceof SharedArrayBuffer;
    info.memoryIsShared = mod.wasmMemory?.buffer instanceof SharedArrayBuffer;
    info.poolSize = mod.PThread?.unusedWorkers?.length ?? null;

    // 原生函式
    if (typeof mod.thread_config === "function") {
      info.threadConfig = mod.thread_config();
    }
    if (typeof mod.system_info === "function") {
      info.systemInfo = mod.system_info();
    }

    // 決定性測試：真的開 4 個 std::thread
    if (typeof mod.thread_selftest === "function") {
      const t0 = performance.now();
      info.selftest = mod.thread_selftest();
      info.selftestMs = Math.round(performance.now() - t0);
    } else {
      info.selftest = "函式不存在";
    }
  } catch (err) {
    info.error = err?.message || String(err);
  }

  self.postMessage({ type: "diag-result", info });
};
