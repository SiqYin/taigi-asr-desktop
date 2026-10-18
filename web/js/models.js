/* 台語辨識模型登記表（與桌面端同一顆模型的 whisper.cpp GGML 版本）。
 *
 * 桌面端：paulpengtw/faster-whisper-Breeze-ASR-26（CT2，約 2.9 GB）
 * 網頁端：weemed/Breeze-ASR-26-GGML（whisper.cpp，Q4_0 / Q5_0）
 * 兩者都是 MediaTek-Research/Breeze-ASR-26 的轉換版，語言設定同樣是 zh。
 */

export const MODELS = {
  q4: {
    id: "breeze-q4_0",
    repo: "weemed/Breeze-ASR-26-GGML",
    file: "breeze-q4_0.bin",
    bytes: 888932908,
    label: "Q4_0 · 848 MB（建議）",
    runtime: "whisper.cpp GGML Q4_0",
  },
  q5: {
    id: "breeze-q5_0",
    repo: "weemed/Breeze-ASR-26-GGML",
    file: "breeze-q5_0.bin",
    bytes: 1080732108,
    label: "Q5_0 · 1.03 GB（精度略高）",
    runtime: "whisper.cpp GGML Q5_0",
  },
};

export const DEFAULT_MODEL_KEY = "q4";

export function resolveModel(key) {
  const model = MODELS[key] || MODELS[DEFAULT_MODEL_KEY];
  return {
    ...model,
    url: `https://huggingface.co/${model.repo}/resolve/main/${model.file}`,
  };
}

export function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}
