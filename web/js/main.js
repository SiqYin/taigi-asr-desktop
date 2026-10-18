/* 台語語音轉錄 · 網頁版 —— 主控邏輯。
 *
 * 與桌面端 Workspace（src/workspace.ts）對齊的行為：
 *   拖放／選擇多檔 → 待處理清單 → 開始轉錄 → 任務列表（狀態、進度、逐字稿）
 *   → 輸出 SRT / VTT / TXT / JSON；另外加上網頁端獨有的「預覽上字幕」。
 */

import { decodeToMono16k, planWindows, isKnownMedia, DecodeCancelled } from "./audio.js";
import { ensureModelBlob, storageEstimate, cachedModelKeys } from "./cache.js";
import { resolveModel, formatBytes, DEFAULT_MODEL_KEY } from "./models.js";
import { WRITERS, EXT_MIME, fileStem, formatClock, saveTextFile, PyInt } from "./subtitles.js";

const STATUS_LABEL = {
  queued: "等待中",
  decoding: "解碼音訊",
  loading: "載入模型",
  transcribing: "辨識中",
  writing: "輸出檔案",
  done: "完成",
  error: "失敗",
  cancelled: "已取消",
};

const ACTIVE_STATES = new Set(["queued", "decoding", "loading", "transcribing", "writing"]);

const SETTINGS_KEY = "taigi-asr-web:settings";

/** 輕量 DOM 助手（與桌面端 workspace.ts 的 h() 對應）。 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key === "text") el.textContent = String(value);
    else if (key === "html") el.innerHTML = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function basename(path) {
  return String(path).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

class Toast {
  constructor(root) {
    this.root = root;
  }
  show(text) {
    const el = h("div", { class: "toast", text });
    this.root.append(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 320);
    }, 4200);
  }
}

class Engine {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.loading = false;
    this.loadPromise = null;
    this.pending = new Map();
    this.statusListeners = new Set();
    this.threads = 1;
  }

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  emit(status) {
    for (const fn of this.statusListeners) {
      try {
        fn(status);
      } catch (err) {
        console.error(err);
      }
    }
  }

  spawn() {
    if (this.worker) return this.worker;
    // WASM 以 ES module 輸出，Worker 也必須是 module 才能 import main.js。
    const worker = new Worker(new URL("./engine-worker.js", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event) => this.onMessage(event.data);
    worker.onerror = (event) => {
      this.emit({ type: "error", message: event.message || "Worker 發生錯誤" });
      this.rejectAll(new Error(event.message || "Worker 發生錯誤"));
    };
    this.worker = worker;
    return worker;
  }

  onMessage(data) {
    switch (data.type) {
      case "status":
        this.emit({ type: "status", phase: data.phase, message: data.message, fraction: data.fraction });
        break;
      case "ready":
        this.threads = data.threads || 1;
        this.emit({ type: "wasm-ready", threads: this.threads });
        break;
      case "loaded":
        this.ready = true;
        this.loading = false;
        this.emit({ type: "loaded", model: data.model });
        this.resolveLoad();
        break;
      case "native-progress":
        this.emit({ type: "native-progress", percent: data.percent });
        break;
      case "progress": {
        const entry = this.pending.get(data.id);
        entry?.onProgress?.(data.fraction ?? 0, data.message || "");
        break;
      }
      case "result": {
        const entry = this.pending.get(data.id);
        this.pending.delete(data.id);
        entry?.resolve({ segments: data.segments || [], duration: data.duration });
        break;
      }
      case "cancelled": {
        const entry = this.pending.get(data.id);
        this.pending.delete(data.id);
        entry?.reject(new DecodeCancelled());
        break;
      }
      case "error": {
        this.emit({ type: "error", message: data.message });
        if (data.id) {
          const entry = this.pending.get(data.id);
          this.pending.delete(data.id);
          entry?.reject(new Error(data.message));
        } else {
          this.rejectAll(new Error(data.message));
        }
        break;
      }
      default:
        break;
    }
  }

  resolveLoad() {
    this.loadResolve?.();
    this.loadResolve = null;
    this.loadReject = null;
  }

  rejectAll(err) {
    for (const [, entry] of this.pending) entry.reject?.(err);
    this.pending.clear();
    this.loading = false;
    this.loadReject?.(err);
    this.loadResolve = null;
    this.loadReject = null;
  }

  /** 預載模型（可重複呼叫，會共用同一個 Promise）。 */
  load(modelKey) {
    if (this.ready) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;

    const model = resolveModel(modelKey);
    this.loading = true;
    this.spawn();

    this.loadPromise = (async () => {
      // 由主執行緒負責「取得模型」這一步：先查 IndexedDB 快取，沒有才下載，
      // 下載完立刻寫回快取，然後把 Blob 交給 Worker。
      //
      // 為什麼不讓 Worker 自己下載：Worker 拿得到 bytes 卻不方便寫 IndexedDB，
      // 若下載完再由主執行緒補存，等於把 848 MB 下載兩次（實測會多耗
      // 近一倍流量與時間）。Blob 在 postMessage 時是「按引用傳遞」，
      // 不會複製 848 MB 的內容，因此這條路徑沒有額外記憶體成本。
      const { blob } = await ensureModelBlob(model.id, model.url, model.bytes, {
        onProgress: ({ received, total, fromCache }) => {
          if (fromCache) {
            this.emit({ type: "status", phase: "model", message: "使用已快取的模型…", fraction: 1 });
            return;
          }
          const fraction = total ? Math.min(1, received / total) : null;
          const text = total
            ? `下載模型… ${Math.round((received / total) * 100)}%`
            : `下載模型… ${Math.round(received / 1048576)} MB`;
          this.emit({ type: "status", phase: "model", message: text, fraction });
        },
      });

      await new Promise((resolve, reject) => {
        this.loadResolve = resolve;
        this.loadReject = reject;
        this.worker.postMessage({
          type: "load",
          base: new URL("../wasm/", import.meta.url).href,
          model: { id: model.id, url: model.url, bytes: model.bytes },
          blob,
        });
      });
    })().finally(() => {
      this.loadPromise = null;
      this.loading = false;
    });

    return this.loadPromise;
  }

  async transcribe({ pcm, beamSize, wordTimestamps, onProgress, signal }) {
    const id = uid();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      const onAbort = () => {
        this.worker?.postMessage({ type: "cancel", id });
        this.pending.delete(id);
        reject(new DecodeCancelled());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.worker.postMessage({
        type: "transcribe",
        id,
        pcm,
        language: "zh",
        beamSize,
        wordTimestamps,
      });
    });
  }
}

class App {
  constructor() {
    this.jobs = [];
    this.staged = [];
    this.expanded = new Set();
    this.settings = this.loadSettings();
    this.engine = new Engine();
    this.toast = new Toast(document.getElementById("toasts"));
    this.busy = false;
    this.preview = null;
    this.blobUrls = new Map();
    this.capabilities = this.detectCapabilities();
  }

  // ---------- 設定 ----------

  loadSettings() {
    const defaults = {
      formats: ["srt"],
      beamSize: 5,
      wordTimestamps: false,
      modelKey: DEFAULT_MODEL_KEY,
    };
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return defaults;
      const saved = JSON.parse(raw);
      return {
        formats: Array.isArray(saved.formats) && saved.formats.length ? saved.formats : defaults.formats,
        beamSize: [1, 3, 5].includes(saved.beamSize) ? saved.beamSize : 5,
        wordTimestamps: Boolean(saved.wordTimestamps),
        modelKey: saved.modelKey === "q5" ? "q5" : "q4",
      };
    } catch {
      return defaults;
    }
  }

  saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* 無痕模式可能無法寫入 */
    }
  }

  // ---------- 能力偵測 ----------

  detectCapabilities() {
    const isolated = globalThis.crossOriginIsolated === true;
    const hasSab = typeof SharedArrayBuffer !== "undefined";
    const hasSimd = (() => {
      try {
        // 16 位元組的 v128 常數：支援 SIMD 的引擎才會編譯成功
        return WebAssembly.validate(
          new Uint8Array([
            0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0,
            65, 0, 253, 15, 253, 98, 11,
          ]),
        );
      } catch {
        return false;
      }
    })();
    return { isolated, hasSab, hasSimd, threads: isolated && hasSab };
  }

  // ---------- 啟動 ----------

  async mount() {
    this.cacheDom();
    this.bindEvents();
    this.renderHeader();
    this.renderStaged();
    this.renderJobs();
    this.syncSettingsToUi();
    this.renderCapabilityNote();
    await this.reportStorage();

    this.engine.onStatus((status) => this.onEngineStatus(status));
  }

  cacheDom() {
    this.dom = {
      engineBadge: document.getElementById("engine-badge"),
      modelBadge: document.getElementById("model-badge"),
      dropzone: document.getElementById("dropzone"),
      fileInput: document.getElementById("file-input"),
      pickBtn: document.getElementById("pick-btn"),
      staged: document.getElementById("staged"),
      stagedLabel: document.getElementById("staged-label"),
      startBtn: document.getElementById("start-btn"),
      jobs: document.getElementById("jobs"),
      clearDone: document.getElementById("clear-done"),
      capabilityNote: document.getElementById("capability-note"),
      quality: document.getElementById("quality"),
      modelSelect: document.getElementById("model-select"),
      wordTs: document.getElementById("word-timestamps"),
      previewCard: document.getElementById("preview-card"),
      previewVideo: document.getElementById("preview-video"),
      previewMeta: document.getElementById("preview-meta"),
      previewActions: document.getElementById("preview-actions"),
      previewTranscript: document.getElementById("preview-transcript"),
      previewClose: document.getElementById("preview-close"),
    };
  }

  bindEvents() {
    const { dropzone, fileInput, pickBtn, startBtn, clearDone, previewClose } = this.dom;

    pickBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      fileInput.click();
    });
    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener("change", () => {
      this.addStaged([...fileInput.files]);
      fileInput.value = "";
    });

    // 拖放：桌機與部分平板支援
    let dragDepth = 0;
    const onDragEnter = (event) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      dragDepth += 1;
      dropzone.classList.add("dragging");
    };
    const onDragOver = (event) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropzone.classList.remove("dragging");
    };
    const onDrop = (event) => {
      event.preventDefault();
      dragDepth = 0;
      dropzone.classList.remove("dragging");
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length) this.addStaged(files);
    };
    for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
      window.addEventListener(type, (event) => {
        const handler = { dragenter: onDragEnter, dragover: onDragOver, dragleave: onDragLeave, drop: onDrop }[type];
        handler(event);
      });
    }

    startBtn.addEventListener("click", () => this.startJobs());
    clearDone.addEventListener("click", () => this.clearFinished());
    previewClose.addEventListener("click", () => this.closePreview());

    this.dom.quality.addEventListener("change", () => {
      this.saveSettings({ beamSize: Number(this.dom.quality.value) });
    });
    this.dom.modelSelect.addEventListener("change", () => {
      this.saveSettings({ modelKey: this.dom.modelSelect.value });
      if (this.engine.ready) {
        this.toast.show("模型已變更，重新整理頁面後生效");
      }
    });
    this.dom.wordTs.addEventListener("change", () => {
      this.saveSettings({ wordTimestamps: this.dom.wordTs.checked });
    });

    for (const fmt of ["srt", "vtt", "txt", "json"]) {
      const input = document.getElementById(`fmt-${fmt}`);
      input?.addEventListener("change", () => {
        const picked = ["srt", "vtt", "txt", "json"].filter(
          (f) => document.getElementById(`fmt-${f}`)?.checked,
        );
        this.saveSettings({ formats: picked.length ? picked : ["srt"] });
        if (!picked.length) document.getElementById("fmt-srt").checked = true;
      });
    }

    this.dom.modelBadge.addEventListener("click", () => this.preloadModel());
  }

  syncSettingsToUi() {
    this.dom.quality.value = String(this.settings.beamSize);
    this.dom.modelSelect.value = this.settings.modelKey;
    this.dom.wordTs.checked = this.settings.wordTimestamps;
    for (const fmt of ["srt", "vtt", "txt", "json"]) {
      const input = document.getElementById(`fmt-${fmt}`);
      if (input) input.checked = this.settings.formats.includes(fmt);
    }
  }

  renderCapabilityNote() {
    const { isolated, hasSab, hasSimd } = this.capabilities;
    const parts = [];
    parts.push(`多執行緒：${isolated && hasSab ? "已啟用（cross-origin isolated）" : "未啟用，將以單執行緒執行"}`);
    parts.push(`SIMD：${hasSimd ? "支援" : "不支援（速度會明顯變慢）"}`);
    parts.push(`CPU 執行緒：${navigator.hardwareConcurrency || "未知"}`);
    this.dom.capabilityNote.textContent = parts.join(" · ");
  }

  async reportStorage() {
    const estimate = await storageEstimate();
    if (!estimate?.quota) return;
    const keys = await cachedModelKeys();
    const cached = keys.length ? `已快取模型：${keys.join(", ")}` : "尚未快取模型";
    this.dom.capabilityNote.textContent +=
      ` · 可用空間 ${formatBytes(estimate.quota - (estimate.usage || 0))}（${cached}）`;
  }

  // ---------- 標頭狀態 ----------

  renderHeader() {
    const badge = this.dom.engineBadge;
    const { isolated, hasSimd } = this.capabilities;
    if (!hasSimd) {
      badge.textContent = "引擎：此瀏覽器不支援 WASM SIMD";
      badge.className = "badge badge-warn";
    } else if (this.engine.ready) {
      badge.textContent = `引擎：就緒 · ${this.engine.threads} 執行緒`;
      badge.className = "badge badge-ok";
    } else if (this.engine.loading) {
      badge.textContent = "引擎：載入中…";
      badge.className = "badge badge-warn";
    } else if (isolated) {
      badge.textContent = "引擎：WebAssembly（多執行緒可用）";
      badge.className = "badge";
    } else {
      badge.textContent = "引擎：WebAssembly（單執行緒）";
      badge.className = "badge badge-warn";
    }

    const model = this.dom.modelBadge;
    if (this.engine.ready) {
      model.textContent = `模型：已載入（${resolveModel(this.settings.modelKey).label.split(" · ")[0]}）`;
      model.className = "badge badge-model state-loaded";
    } else if (this.engine.loading) {
      model.textContent = "模型：載入中…";
      model.className = "badge badge-model state-loading";
    } else {
      model.textContent = "模型：未載入（點此預載）";
      model.className = "badge badge-model state-idle";
    }
  }

  onEngineStatus(status) {
    if (status.type === "status") {
      if (status.message) {
        this.dom.engineBadge.textContent = `引擎：${status.message}`;
      }
      if (typeof status.fraction === "number" && this.engine.loading) {
        this.dom.modelBadge.textContent = `模型：${Math.round(status.fraction * 100)}%`;
      }
      this.renderHeader();
      if (this.engine.loading) {
        if (status.message) this.dom.engineBadge.textContent = `引擎：${status.message}`;
        if (typeof status.fraction === "number") {
          this.dom.modelBadge.textContent = `模型：${Math.round(status.fraction * 100)}%`;
          this.dom.modelBadge.className = "badge badge-model state-loading";
        }
      }
    } else if (status.type === "loaded") {
      this.renderHeader();
      this.toast.show("模型已就緒，可以開始轉錄");
    } else if (status.type === "error") {
      this.renderHeader();
      this.toast.show(`引擎錯誤：${status.message}`);
    }
  }

  async preloadModel() {
    if (this.engine.ready || this.engine.loading) return;
    try {
      this.engine.load(this.settings.modelKey);
    } catch (err) {
      this.toast.show(`無法預載模型：${err.message}`);
    }
  }

  // ---------- 待處理檔案 ----------

  addStaged(files) {
    const known = new Set(this.staged.map((f) => `${f.name}:${f.size}`));
    for (const file of files) {
      if (!(file instanceof File)) continue;
      const key = `${file.name}:${file.size}`;
      if (known.has(key)) continue;
      known.add(key);
      this.staged.push(file);
      if (!isKnownMedia(file.name, file.type)) {
        this.toast.show(`提示：${file.name} 的格式不在已知清單，仍會嘗試解碼`);
      }
    }
    this.renderStaged();
  }

  removeStaged(index) {
    this.staged.splice(index, 1);
    this.renderStaged();
  }

  renderStaged() {
    const { staged, stagedLabel, startBtn } = this.dom;
    staged.replaceChildren();
    stagedLabel.textContent = this.staged.length ? `待處理（${this.staged.length}）` : "待處理";
    if (!this.staged.length) {
      startBtn.disabled = true;
      return;
    }
    this.staged.forEach((file, index) => {
      staged.append(
        h(
          "div",
          { class: "chip", title: file.name },
          h("span", { class: "chip-name", text: file.name }),
          h("span", { class: "muted", text: formatBytes(file.size) }),
          h("button", {
            class: "chip-x",
            type: "button",
            title: "移除",
            text: "×",
            onclick: (event) => {
              event.stopPropagation();
              this.removeStaged(index);
            },
          }),
        ),
      );
    });
    startBtn.disabled = this.busy;
  }

  // ---------- 任務 ----------

  async startJobs() {
    if (!this.staged.length || this.busy) return;
    const files = [...this.staged];
    this.staged = [];
    this.renderStaged();
    this.busy = true;
    this.dom.startBtn.disabled = true;

    try {
      await this.engine.load(this.settings.modelKey);
    } catch (err) {
      this.toast.show(`模型載入失敗：${err.message}`);
      this.busy = false;
      this.addStaged(files);
      this.renderStaged();
      return;
    }

    for (const file of files) {
      // 逐檔處理：模型只載入一次，與桌面端的單 worker 佇列一致。
      await this.runJob(file);
    }

    this.busy = false;
    this.renderStaged();
  }

  createJob(file) {
    const job = {
      id: uid(),
      file,
      name: file.name,
      status: "queued",
      progress: 0,
      message: "等待中",
      segments: [],
      duration: null,
      outputs: [],
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      controller: new AbortController(),
    };
    this.jobs.push(job);
    return job;
  }

  updateJob(job, patch) {
    Object.assign(job, patch);
    this.renderJobs();
  }

  async runJob(file) {
    const job = this.createJob(file);
    this.updateJob(job, { status: "decoding", progress: 0.01, message: "解碼音訊…", startedAt: Date.now() });

    try {
      const { pcm } = await decodeToMono16k(file, {
        signal: job.controller.signal,
        onStage: (message) => this.updateJob(job, { message }),
      });
      job.duration = pcm.length / 16000;
      this.updateJob(job, { progress: 0.03, message: "解碼完成" });

      const windows = planWindows(pcm, 16000);
      const totalWindows = windows.length;
      const collected = [];

      // 逐塊順序辨識。
      //
      // 為什麼不用 whisper_full_parallel：它在 Emscripten 的 pthread 環境下
      // 會因為 C++ 例外 unwinding 而 abort（實測 "unwind" 崩潰），且需要把
      // 整段長音訊放進 WASM 記憶體。改成前端切塊、逐塊呼叫 whisper_full，
      // 記憶體佔用固定、進度與取消都更即時，也避開了那個崩潰。
      for (let i = 0; i < totalWindows; i += 1) {
        if (job.controller.signal.aborted) throw new DecodeCancelled();
        const win = windows[i];
        const startSample = Math.round(win.start * 16000);
        const endSample = Math.round(win.end * 16000);
        const slice = pcm.subarray(startSample, endSample);
        // 複製一份：postMessage 會結構化複製，避免整段 pcm 被保留。
        const chunk = new Float32Array(slice);

        this.updateJob(job, {
          status: "transcribing",
          progress: 0.03 + (i / totalWindows) * 0.92,
          message:
            totalWindows > 1
              ? `台語辨識中…（第 ${i + 1}/${totalWindows} 塊）`
              : "台語辨識中…",
        });

        const result = await this.engine.transcribe({
          pcm: chunk,
          beamSize: this.settings.beamSize,
          wordTimestamps: this.settings.wordTimestamps,
          signal: job.controller.signal,
          onProgress: (fraction, message) => {
            const base = 0.03 + (i / totalWindows) * 0.92;
            const span = 0.92 / totalWindows;
            this.updateJob(job, {
              progress: Math.min(0.95, base + fraction * span),
              message: message || job.message,
            });
          },
        });

        for (const seg of result.segments) {
          const start = seg.start + win.start;
          const end = seg.end + win.start;
          if (!seg.text) continue;
          collected.push({ start, end, text: seg.text });
        }
        this.updateJob(job, {
          progress: 0.03 + ((i + 1) / totalWindows) * 0.92,
          segments: [...collected],
        });
      }

      // 相鄰區塊交界處可能出現重複句，做一次保守去重。
      const segments = dedupeSegments(collected);
      this.updateJob(job, { status: "writing", progress: 0.96, message: "輸出字幕檔…", segments });

      const outputs = await this.writeOutputs(job, segments);
      this.updateJob(job, {
        status: "done",
        progress: 1,
        message: `完成（${segments.length} 句）`,
        outputs,
        finishedAt: Date.now(),
      });
      this.openPreview(job);
    } catch (err) {
      if (err instanceof DecodeCancelled || job.controller.signal.aborted) {
        this.updateJob(job, { status: "cancelled", message: "已取消", finishedAt: Date.now() });
      } else {
        this.updateJob(job, {
          status: "error",
          message: "失敗",
          error: err?.message || String(err),
          finishedAt: Date.now(),
        });
        this.toast.show(`「${job.name}」轉錄失敗：${err?.message || err}`);
      }
    }
  }

  async writeOutputs(job, segments) {
    const meta = {
      engine: "whisper.cpp-Breeze-ASR-26-GGML",
      runtime: "WebAssembly",
      model: resolveModel(this.settings.modelKey).id,
      language: "zh",
      beam_size: new PyInt(this.settings.beamSize),
      word_timestamps: this.settings.wordTimestamps,
      duration: job.duration,
      source: job.name,
      created_at: new Date().toISOString(),
    };
    const stem = fileStem(job.name);
    const outputs = [];
    for (const fmt of this.settings.formats) {
      const writer = WRITERS[fmt];
      if (!writer) continue;
      const text = writer(segments, meta);
      const filename = `${stem}.${fmt}`;
      const savedPath = saveTextFile(filename, text, EXT_MIME[fmt]);
      outputs.push({ fmt, filename, path: savedPath });
      // 連續下載之間留一點間隔，避免瀏覽器合併或攔截。
      await new Promise((r) => setTimeout(r, 120));
    }
    return outputs;
  }

  cancelJob(job) {
    job.controller.abort();
    this.updateJob(job, { message: "取消中…" });
  }

  clearFinished() {
    this.jobs = this.jobs.filter((job) => ACTIVE_STATES.has(job.status));
    this.renderJobs();
  }

  // ---------- 任務列表繪製 ----------

  renderJobs() {
    const container = this.dom.jobs;
    container.replaceChildren();
    const finished = this.jobs.some((job) => !ACTIVE_STATES.has(job.status));
    this.dom.clearDone.hidden = !finished;

    if (!this.jobs.length) {
      container.append(
        h("div", { class: "empty", text: "尚無任務。加入影片或音訊後按「開始轉錄」。" }),
      );
      return;
    }

    for (const job of this.jobs) container.append(this.renderJob(job));
  }

  renderJob(job) {
    const active = ACTIVE_STATES.has(job.status);
    const percent = Math.round((job.progress || 0) * 100);

    const actions = [];
    if (active) {
      actions.push(
        h("button", {
          class: "btn btn-ghost btn-sm",
          type: "button",
          text: "取消",
          onclick: () => this.cancelJob(job),
        }),
      );
    }
    if (job.status === "done" && job.segments.length) {
      actions.push(
        h("button", {
          class: "btn btn-out btn-sm",
          type: "button",
          text: "預覽／上字幕",
          onclick: () => this.openPreview(job),
        }),
      );
      actions.push(
        h("button", {
          class: "btn btn-ghost btn-sm",
          type: "button",
          text: "重新下載字幕",
          onclick: () => {
            void this.writeOutputs(job, job.segments);
          },
        }),
      );
    }

    const metaParts = [];
    if (job.duration) metaParts.push(`長度 ${formatClock(job.duration)}`);
    if (job.startedAt) {
      const end = job.finishedAt ?? Date.now();
      metaParts.push(`耗時 ${formatClock((end - job.startedAt) / 1000)}`);
    }

    const bar =
      active || job.status === "done" || job.status === "error"
        ? h(
            "div",
            { class: "bar" },
            h("div", {
              class: `bar-fill bar-${job.status}`,
              style: `width:${percent}%`,
            }),
          )
        : null;

    const parts = [
      h(
        "div",
        { class: "job-head" },
        h("span", { class: `dot dot-${job.status}` }),
        h(
          "div",
          { class: "job-name" },
          h("div", { class: "job-file", text: job.name }),
          h("div", { class: "job-dir muted", text: formatBytes(job.file.size) }),
        ),
        h(
          "div",
          { class: "job-status" },
          h("div", { class: `status-text st-${job.status}`, text: STATUS_LABEL[job.status] || job.status }),
          h("div", { class: "job-meta muted", text: metaParts.join(" · ") }),
        ),
        actions.length ? h("div", { class: "job-actions" }, ...actions) : null,
      ),
      bar,
    ];

    if (active) parts.push(h("div", { class: "job-msg muted", text: job.message }));
    if (job.error) parts.push(h("div", { class: "job-error", text: job.error }));

    if (job.segments.length) {
      const expanded = this.expanded.has(job.id);
      parts.push(
        h(
          "div",
          { class: "seg-toggle" },
          h("button", {
            class: "btn btn-ghost btn-sm",
            type: "button",
            text: expanded ? "收合逐字稿" : `檢視逐字稿（${job.segments.length} 句）`,
            onclick: () => {
              if (this.expanded.has(job.id)) this.expanded.delete(job.id);
              else this.expanded.add(job.id);
              this.renderJobs();
            },
          }),
        ),
      );
      if (expanded) {
        parts.push(
          h(
            "div",
            { class: "transcript" },
            ...job.segments.map((seg) =>
              h(
                "div",
                { class: "seg" },
                h("span", { class: "seg-time", text: formatClock(seg.start) }),
                h("span", { class: "seg-text", text: seg.text }),
              ),
            ),
          ),
        );
      }
    }

    return h("div", { class: `job job-${job.status}` }, ...parts.filter(Boolean));
  }

  // ---------- 預覽與上字幕 ----------

  openPreview(job) {
    const card = this.dom.previewCard;
    const video = this.dom.previewVideo;

    this.closePreview(false);

    const url = this.blobUrlFor(job.file);
    const isVideo = /^video\//.test(job.file.type) || /\.(mp4|mkv|mov|webm|avi|m4v)$/i.test(job.name);

    // 不論音訊或影片都用 <video> 元素承載：它同時能播純音訊，
    // 且能掛 <track> 字幕軌。純音訊時隱藏畫面但保留播放與字幕。
    video.hidden = false;
    video.src = url;
    video.controls = true;

    // 掛上 VTT 字幕軌：由轉錄結果即時產生，這就是「上字幕」。
    const vtt = WRITERS.vtt(job.segments);
    const trackUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    this.previewTrackUrl = trackUrl;
    video.appendChild(
      h("track", {
        kind: "subtitles",
        label: "台語（自動）",
        srclang: "nan",
        src: trackUrl,
        default: true,
      }),
    );
    // 預設開啟字幕
    const enableTrack = () => {
      const track = video.textTracks[0];
      if (track) track.mode = "showing";
    };
    enableTrack();
    video.addEventListener("loadedmetadata", enableTrack, { once: true });

    // 純音訊：把畫面區縮成只顯示字幕的橫條（audio 沒有影像可看）
    video.classList.toggle("audio-only", !isVideo);

    this.dom.previewMeta.textContent = `${job.name} · ${job.segments.length} 句 · ${formatClock(job.duration || 0)}`;

    const actions = this.dom.previewActions;
    actions.replaceChildren();
    for (const fmt of ["srt", "vtt", "txt", "json"]) {
      actions.append(
        h("button", {
          class: "btn btn-ghost btn-sm",
          type: "button",
          text: `下載 ${fmt.toUpperCase()}`,
          onclick: () => {
            const text = WRITERS[fmt](job.segments, { source: job.name, language: "zh" });
            saveTextFile(`${fileStem(job.name)}.${fmt}`, text, EXT_MIME[fmt]);
          },
        }),
      );
    }
    // 字幕切換按鈕對音訊與影片都適用
    actions.append(
      h("button", {
        class: "btn btn-out btn-sm",
        type: "button",
        text: "切換字幕",
        onclick: () => {
          const track = video.textTracks[0];
          if (track) track.mode = track.mode === "showing" ? "hidden" : "showing";
        },
      }),
    );

    const transcript = this.dom.previewTranscript;
    transcript.replaceChildren();
    const rows = job.segments.map((seg) => {
      const row = h(
        "div",
        { class: "seg clickable" },
        h("span", { class: "seg-time", text: formatClock(seg.start) }),
        h("span", { class: "seg-text", text: seg.text }),
      );
      row.addEventListener("click", () => {
        video.currentTime = Math.max(0, seg.start);
        video.play().catch(() => {});
      });
      return row;
    });
    transcript.append(...rows);

    // 播放時同步高亮逐字稿（音訊與影片都適用）
    const syncActive = () => {
      const t = video.currentTime;
      let activeIndex = -1;
      for (let i = 0; i < job.segments.length; i += 1) {
        if (t >= job.segments[i].start && t < job.segments[i].end) {
          activeIndex = i;
          break;
        }
      }
      rows.forEach((row, i) => row.classList.toggle("active", i === activeIndex));
      if (activeIndex >= 0) {
        const row = rows[activeIndex];
        const rect = row.getBoundingClientRect();
        const box = transcript.getBoundingClientRect();
        if (rect.top < box.top || rect.bottom > box.bottom) {
          row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      }
    };
    video.addEventListener("timeupdate", syncActive);
    this.previewCleanup = () => video.removeEventListener("timeupdate", syncActive);

    card.hidden = false;
    this.preview = job;
    // 小螢幕上把預覽捲進視野
    if (window.matchMedia("(max-width: 1023px)").matches) {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  closePreview(clear = true) {
    const video = this.dom.previewVideo;
    this.previewCleanup?.();
    this.previewCleanup = null;
    if (this.previewTrackUrl) {
      URL.revokeObjectURL(this.previewTrackUrl);
      this.previewTrackUrl = null;
    }
    video.pause?.();
    video.querySelectorAll("track").forEach((t) => t.remove());
    if (clear) {
      this.dom.previewCard.hidden = true;
      this.preview = null;
    }
  }

  blobUrlFor(file) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (this.blobUrls.has(key)) return this.blobUrls.get(key);
    const url = URL.createObjectURL(file);
    this.blobUrls.set(key, url);
    return url;
  }
}

/** 去除跨區塊重複的句子（只處理時間與文字都高度重疊的情況）。 */
function dedupeSegments(segments) {
  const out = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.text === seg.text && Math.abs(prev.start - seg.start) < 0.6) continue;
    out.push(seg);
  }
  return out;
}

const app = new App();
app.mount().catch((err) => {
  console.error(err);
  document.getElementById("app").textContent = `啟動失敗：${err?.message || err}`;
});

// 供 Android 殼與除錯使用
globalThis.__taigiApp = app;
