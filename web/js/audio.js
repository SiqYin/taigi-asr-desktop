/* 音訊解碼：任何影音檔 → 16 kHz 單聲道 Float32Array，並切成適合瀏覽器記憶體的區塊。
 *
 * 主路徑：decodeAudioData（瀏覽器內建解碼器，支援 mp3 / m4a / aac / wav / flac /
 *         ogg / opus / webm / mp4 等），再用 OfflineAudioContext 重採樣為 16 kHz 單聲道。
 * 後備路徑：decodeAudioData 不認得的容器（例如 mkv / mov / avi / ts）改用 <video>
 *         元素即時播放 + MediaElementSource 擷取（需要即時播放一次，速度為 1×）。
 */

export const TARGET_SAMPLE_RATE = 16000;

const AUDIO_VIDEO_EXTENSIONS = [
  "mp3", "m4a", "wav", "flac", "ogg", "webm", "mp4", "mkv",
  "mov", "aac", "opus", "wma", "avi", "aiff", "3gp", "ts",
];

export function extensionOf(name) {
  const base = String(name).split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function isKnownMedia(name, mime = "") {
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return true;
  return AUDIO_VIDEO_EXTENSIONS.includes(extensionOf(name));
}

export function isProbablyVideo(name, mime = "") {
  if (mime.startsWith("video/")) return true;
  return ["mp4", "mkv", "mov", "webm", "avi", "ts", "3gp", "wmv", "flv", "m4v"].includes(
    extensionOf(name),
  );
}

export class DecodeCancelled extends Error {
  constructor() {
    super("已取消");
    this.name = "DecodeCancelled";
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DecodeCancelled();
}

/** 用 media 元素讀出時長（秒）。 */
export function probeDuration(file) {
  return new Promise((resolve) => {
    const el = document.createElement(isProbablyVideo(file.name, file.type) ? "video" : "audio");
    const url = URL.createObjectURL(file);
    const done = (value) => {
      URL.revokeObjectURL(url);
      el.removeAttribute("src");
      resolve(value);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    el.src = url;
  });
}

/** 解碼 + 重採樣成 16 kHz 單聲道。 */
export async function decodeToMono16k(file, { onStage = () => {}, signal } = {}) {
  throwIfAborted(signal);
  onStage("讀取檔案…");
  const arrayBuffer = await file.arrayBuffer();
  throwIfAborted(signal);

  onStage("解碼音訊…");
  try {
    const pcm = await decodeWithAudioContext(arrayBuffer, signal);
    return { pcm, sampleRate: TARGET_SAMPLE_RATE, fallback: false };
  } catch (err) {
    if (err instanceof DecodeCancelled) throw err;
    console.warn("decodeAudioData 失敗，改用即時擷取：", err);
  }

  throwIfAborted(signal);
  onStage("檔案格式需即時解碼，正在以播放方式擷取音訊（1× 速度）…");
  const pcm = await decodeByPlayback(file, { onStage, signal });
  return { pcm, sampleRate: TARGET_SAMPLE_RATE, fallback: true };
}

async function decodeWithAudioContext(arrayBuffer, signal) {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioCtx) throw new Error("瀏覽器不支援 Web Audio API");
  const ctx = new AudioCtx();
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    ctx.close?.();
  }
  throwIfAborted(signal);
  if (!buffer || !buffer.length) throw new Error("音訊內容為空");

  const frames = Math.max(1, Math.ceil(buffer.duration * TARGET_SAMPLE_RATE));
  const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const offline = new OfflineCtx(1, frames, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/** 後備：即時播放並擷取（可用於 Chrome 能播放、但 decodeAudioData 不支援的容器）。 */
function decodeByPlayback(file, { onStage, signal }) {
  return new Promise((resolve, reject) => {
    const video = isProbablyVideo(file.name, file.type);
    const el = document.createElement(video ? "video" : "audio");
    el.preload = "auto";
    el.muted = true;
    el.playsInline = true;
    el.crossOrigin = "anonymous";
    const url = URL.createObjectURL(file);
    el.src = url;

    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    let ctx = null;
    let sourceNode = null;
    let processor = null;
    let sink = null;
    let finished = false;

    const cleanup = () => {
      try {
        processor?.disconnect();
        sourceNode?.disconnect();
        sink?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        ctx?.close();
      } catch {
        /* ignore */
      }
      el.pause();
      el.removeAttribute("src");
      URL.revokeObjectURL(url);
    };

    const fail = (message) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error(message));
    };

    const abortHandler = () => fail("已取消");
    signal?.addEventListener("abort", abortHandler, { once: true });

    el.onerror = () => fail("瀏覽器無法解碼這個檔案的音訊軌（容器或編碼不支援）");

    el.onloadedmetadata = async () => {
      try {
        if (typeof el.captureStream !== "function") {
          fail("此瀏覽器不支援從媒體元素擷取音訊，請改用 Chrome / Edge 桌機版，或先以 ffmpeg 轉成 mp3 / m4a。");
          return;
        }
        const stream = el.captureStream();
        if (!stream.getAudioTracks().length) {
          fail("檔案裡找不到音訊軌（可能只有視訊）。");
          return;
        }
        ctx = new AudioCtx({ sampleRate: TARGET_SAMPLE_RATE });
        sourceNode = ctx.createMediaStreamSource(stream);
        processor = ctx.createScriptProcessor(4096, 1, 1);
        const chunks = [];
        let total = 0;
        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          const copy = new Float32Array(input.length);
          copy.set(input);
          chunks.push(copy);
          total += copy.length;
          const duration = el.duration;
          if (duration > 0) {
            onStage(`即時擷取中… ${Math.round((el.currentTime / duration) * 100)}%`);
          }
        };
        const muteGain = ctx.createGain();
        muteGain.gain.value = 0;
        sourceNode.connect(processor);
        processor.connect(muteGain);
        muteGain.connect(ctx.destination);
        sink = muteGain;

        const finish = () => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener("abort", abortHandler);
          const pcm = new Float32Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            pcm.set(chunk, offset);
            offset += chunk.length;
          }
          cleanup();
          if (!pcm.length) {
            reject(new Error("擷取不到音訊內容"));
          } else {
            resolve(pcm);
          }
        };

        el.onended = finish;
        await el.play();
      } catch (err) {
        fail(`即時擷取失敗：${err?.message || err}`);
      }
    };
  });
}

/** 以 50 ms 為一格計算 RMS，用於尋找安靜切點。 */
function rmsFrames(pcm, sampleRate, frameMs = 50) {
  const frame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const count = Math.floor(pcm.length / frame);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    const start = i * frame;
    for (let j = 0; j < frame; j += 1) {
      const v = pcm[start + j];
      sum += v * v;
    }
    out[i] = Math.sqrt(sum / frame);
  }
  return { frames: out, frameMs };
}

/**
 * 依安靜點把長音訊切成區塊（預設 300 秒），避免一次把整段音訊放進 WASM 記憶體，
 * 也讓進度與取消更即時。
 */
export function planWindows(pcm, sampleRate, { targetSeconds = 300, searchSeconds = 8 } = {}) {
  const totalSeconds = pcm.length / sampleRate;
  if (totalSeconds <= targetSeconds + searchSeconds) {
    return [{ start: 0, end: totalSeconds }];
  }

  const { frames, frameMs } = rmsFrames(pcm, sampleRate);
  const searchFrames = Math.max(1, Math.round(searchSeconds * 1000 / frameMs));
  const windows = [];
  let cursor = 0;

  while (totalSeconds - cursor > targetSeconds + searchSeconds) {
    const targetFrame = Math.round(((cursor + targetSeconds) * 1000) / frameMs);
    const lo = Math.max(Math.round((cursor * 1000) / frameMs) + searchFrames, targetFrame - searchFrames);
    const hi = Math.min(frames.length - 1, targetFrame + searchFrames);
    let bestFrame = targetFrame;
    let bestValue = Infinity;
    for (let i = lo; i <= hi; i += 1) {
      if (frames[i] < bestValue) {
        bestValue = frames[i];
        bestFrame = i;
      }
    }
    const end = Math.min(totalSeconds, (bestFrame * frameMs) / 1000);
    if (end - cursor < 30) {
      // 安靜點太靠近起點時，直接硬切在目標位置，避免區塊過短。
      windows.push({ start: cursor, end: Math.min(totalSeconds, cursor + targetSeconds) });
      cursor = Math.min(totalSeconds, cursor + targetSeconds);
    } else {
      windows.push({ start: cursor, end });
      cursor = end;
    }
  }

  if (cursor < totalSeconds) windows.push({ start: cursor, end: totalSeconds });
  return windows;
}
