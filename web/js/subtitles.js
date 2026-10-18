/* 字幕輸出格式：與桌面端 taigi_asr.formatters / segments.py 完全一致。
 *
 * - TXT ：[HH:MM:SS - HH:MM:SS] 文字
 * - SRT ：序號 / HH:MM:SS,mmm --> HH:MM:SS,mmm / 文字（每塊後空行，檔尾再一空行）
 * - VTT ：WEBVTT 標頭 + HH:MM:SS.mmm --> HH:MM:SS.mmm / 文字
 * - JSON：{"segments":[{start,end,text}...],"meta":{...}}（縮排 2、保留中文不轉義）
 */

const pad = (n, width) => String(n).padStart(width, "0");

/** 桌面端 TimestampedSegment.format_time 的 JS 版。 */
export function formatTime(seconds, srtFormat = false) {
  let s = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;

  if (srtFormat) {
    const totalMs = Math.round(s * 1000);
    const ms = totalMs % 1000;
    const totalS = Math.floor(totalMs / 1000);
    const sec = totalS % 60;
    const totalM = Math.floor(totalS / 60);
    const min = totalM % 60;
    const hour = Math.floor(totalM / 60);
    return `${pad(hour, 2)}:${pad(min, 2)}:${pad(sec, 2)},${pad(ms, 3)}`;
  }

  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}`;
}

/** 畫面用的短時鐘（1:23 / 1:02:03）。 */
export function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh > 0
    ? `${hh}:${pad(mm, 2)}:${pad(ss, 2)}`
    : `${mm}:${pad(ss, 2)}`;
}

export function toTxt(segments) {
  if (!segments.length) return "";
  return segments
    .map((s) => `[${formatTime(s.start)} - ${formatTime(s.end)}] ${s.text}\n`)
    .join("");
}

function srtBlock(segment, index) {
  const start = formatTime(segment.start, true);
  const end = formatTime(segment.end, true);
  return `${index}\n${start} --> ${end}\n${segment.text}\n`;
}

export function toSrt(segments) {
  if (!segments.length) return "";
  return segments.map((s, i) => srtBlock(s, i + 1)).join("\n") + "\n";
}

function vttBlock(segment) {
  const start = formatTime(segment.start, true).replace(",", ".");
  const end = formatTime(segment.end, true).replace(",", ".");
  return `${start} --> ${end}\n${segment.text}\n`;
}

export function toVtt(segments) {
  if (!segments.length) return "WEBVTT\n\n";
  return `WEBVTT\n\n${segments.map(vttBlock).join("\n")}`;
}

/**
 * 整數包裝：桌面端 JSON 的 meta.beam_size 是 Python int，序列化成 `5`；
 * 其餘數值（時間、時長）都是 float，序列化成 `5.0`。用這個標記區分。
 */
export class PyInt {
  constructor(value) {
    this.value = value;
  }
}

/** Python `repr(float)` 風格：整數值補小數點，指數形式補足兩位。 */
export function pyFloatRepr(value) {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";

  const abs = Math.abs(value);
  // Python：1e-4 <= |v| < 1e16 用定點表示，其餘用指數表示。
  if (abs >= 1e-4 && abs < 1e16) {
    if (Number.isInteger(value)) return value.toFixed(1);
    return String(value);
  }

  // JS 的 String() 在 1e-6 以下／1e21 以上才轉指數，這裡統一成 Python 風格。
  let text = value.toExponential();
  text = text.replace(/e([+-])(\d)$/, "e$10$2");
  return text;
}

/** 對齊 Python json.dumps(obj, ensure_ascii=False, indent=2) 的序列化器。 */
function pyJson(value, level = 0) {
  const pad = "  ".repeat(level);
  const padIn = "  ".repeat(level + 1);

  if (value instanceof PyInt) return String(Math.trunc(value.value));
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return pyFloatRepr(value);
  if (typeof value === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => padIn + pyJson(item, level + 1));
    return `[\n${items.join(",\n")}\n${pad}]`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined);
    if (keys.length === 0) return "{}";
    const items = keys.map(
      (key) => `${padIn}${JSON.stringify(key)}: ${pyJson(value[key], level + 1)}`,
    );
    return `{\n${items.join(",\n")}\n${pad}}`;
  }

  return "null";
}

export function toJson(segments, meta) {
  const payload = {
    segments: segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
  };
  if (meta) payload.meta = { ...meta };
  return pyJson(payload);
}

/** 格式 → 產生器（json 需要 meta，因此用統一的 writers 介面）。 */
export const WRITERS = {
  txt: (segments) => toTxt(segments),
  srt: (segments) => toSrt(segments),
  vtt: (segments) => toVtt(segments),
  json: (segments, meta) => toJson(segments, meta),
};

export const EXT_MIME = {
  srt: "application/x-subrip;charset=utf-8",
  vtt: "text/vtt;charset=utf-8",
  txt: "text/plain;charset=utf-8",
  json: "application/json;charset=utf-8",
};

/** 去掉副檔名，作為輸出檔名主體。 */
export function fileStem(name) {
  const base = String(name).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "output";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function toBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 儲存文字檔。
 * - 網頁：<a download>（存到瀏覽器下載資料夾）
 * - Android 殼：交由 TaigiAndroid.saveText 寫入系統下載目錄
 * 回傳 Android 上的儲存路徑，網頁上回傳 null。
 */
export function saveTextFile(filename, text, mime = "text/plain;charset=utf-8") {
  const bridge = globalThis.TaigiAndroid;
  if (bridge && typeof bridge.saveText === "function") {
    try {
      const bytes = new TextEncoder().encode(text);
      const path = bridge.saveText(filename, mime, toBase64(bytes));
      return typeof path === "string" ? path : null;
    } catch (err) {
      console.error("TaigiAndroid.saveText 失敗，改用瀏覽器下載", err);
    }
  }

  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return null;
}
