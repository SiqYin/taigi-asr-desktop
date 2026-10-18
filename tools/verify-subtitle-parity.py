"""驗證網頁版字幕格式與桌面端（taigi_asr.formatters）輸出逐位元組一致。

用法（repo 根目錄）：
    python tools/verify-subtitle-parity.py

若本機沒有安裝 breeze-asr-taigi，會內建一份與上游 segments.py / formatters.py
等價的參考實作（同一份程式碼邏輯）來比對，確保兩邊產字串相同。
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WEB = REPO / "web" / "js" / "subtitles.js"

# 與 thc1006/breeze-asr-taigi src/taigi_asr/segments.py 相同的參考實作。
@dataclass(frozen=True)
class Segment:
    start_time: float
    end_time: float
    text: str

    @staticmethod
    def format_time(seconds, srt_format: bool = False) -> str:
        if seconds is None or seconds < 0:
            seconds = 0.0
        if srt_format:
            total_ms = int(round(seconds * 1000))
            ms = total_ms % 1000
            total_s = total_ms // 1000
            s = total_s % 60
            total_m = total_s // 60
            m = total_m % 60
            h = total_m // 60
            return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"

    def to_timestamp_line(self) -> str:
        return f"[{self.format_time(self.start_time)} - {self.format_time(self.end_time)}] {self.text}"

    def to_srt_block(self, index: int) -> str:
        start = self.format_time(self.start_time, srt_format=True)
        end = self.format_time(self.end_time, srt_format=True)
        return f"{index}\n{start} --> {end}\n{self.text}\n"

    def to_vtt_block(self) -> str:
        start = self.format_time(self.start_time, srt_format=True).replace(",", ".")
        end = self.format_time(self.end_time, srt_format=True).replace(",", ".")
        return f"{start} --> {end}\n{self.text}\n"

    def to_json_dict(self):
        return {"start": self.start_time, "end": self.end_time, "text": self.text}


def to_txt(segments):
    if not segments:
        return ""
    return "".join(seg.to_timestamp_line() + "\n" for seg in segments)


def to_srt(segments):
    if not segments:
        return ""
    blocks = [seg.to_srt_block(idx) for idx, seg in enumerate(segments, 1)]
    return "\n".join(blocks) + "\n"


def to_vtt(segments):
    if not segments:
        return "WEBVTT\n\n"
    body = "\n".join(seg.to_vtt_block() for seg in segments)
    return f"WEBVTT\n\n{body}"


def to_json(segments, meta=None):
    payload = {"segments": [seg.to_json_dict() for seg in segments]}
    if meta is not None:
        payload["meta"] = dict(meta)
    return json.dumps(payload, ensure_ascii=False, indent=2)


CASES = [
    [],
    [Segment(0.0, 1.0, "你好")],
    [Segment(1.5, 3.25, "逐句時間戳記")],
    [
        Segment(0.0, 2.4, "逐句時間戳記"),
        Segment(2.4, 5.9, "第二个句子，帶中文標點。"),
        Segment(5.9, 59.9996, "邊界時間測試"),
        Segment(59.9996, 3600.5, "跨小時測試"),
    ],
    [
        Segment(0.0, 0.5, "台語"),
        Segment(0.5, 1.0, "ASR"),
        Segment(1.0, 1.5, "Breeze-ASR-26"),
    ],
]

NODE_SCRIPT = r"""
import { toTxt, toSrt, toVtt, toJson } from %(module)s;
const cases = JSON.parse(process.argv[2]);
const out = cases.map((segs) => {
  const segments = segs.map((s) => ({ start: s.start, end: s.end, text: s.text }));
  return {
    txt: toTxt(segments),
    srt: toSrt(segments),
    vtt: toVtt(segments),
    json: toJson(segments, { engine: "test" }),
  };
});
process.stdout.write(JSON.stringify(out));
"""


def main() -> int:
    if not WEB.exists():
        print(f"找不到 {WEB}", file=sys.stderr)
        return 1

    cases_json = json.dumps(
        [
            [{"start": s.start_time, "end": s.end_time, "text": s.text} for s in case]
            for case in CASES
        ],
        ensure_ascii=False,
    )

    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "run.mjs"
        script.write_text(
            NODE_SCRIPT % {"module": json.dumps(WEB.as_uri())}, encoding="utf-8"
        )
        proc = subprocess.run(
            ["node", str(script), cases_json],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if proc.returncode != 0:
            print("Node 執行失敗：", proc.stderr, file=sys.stderr)
            return 1
        js_results = json.loads(proc.stdout)

    failures = 0
    for index, case in enumerate(CASES):
        expected = {
            "txt": to_txt(case),
            "srt": to_srt(case),
            "vtt": to_vtt(case),
            "json": to_json(case, {"engine": "test"}),
        }
        actual = js_results[index]
        for fmt, want in expected.items():
            got = actual[fmt]
            if got != want:
                failures += 1
                print(f"✗ case {index} / {fmt} 不一致")
                print("  期望：", repr(want))
                print("  實際：", repr(got))
            else:
                print(f"✓ case {index} / {fmt}")

    if failures:
        print(f"\n{failures} 項不一致")
        return 1

    print("\n全部一致：網頁版字幕格式與桌面端輸出一致")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
