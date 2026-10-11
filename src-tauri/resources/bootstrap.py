"""首次啟動的環境引導腳本（在 venv 內執行）。

職責：
1. 安裝 requirements.txt（faster-whisper 主力路徑依賴）；
2. 有 NVIDIA GPU 時加裝 CUDA 12 執行期函式庫（失敗則退回 CPU，不中斷）；
3. 以 --no-deps 安裝釘定 commit 的 breeze-asr-taigi（避免拉入 Gradio/torch）；
4. 預先下載 Breeze-ASR-26 的 CT2 模型（約 2.9 GB，只此一次）。

輸出協議：stdout 每行一個 JSON 物件
``{"phase": str, "message": str, "fraction": float | null}``，
由 Rust 端即時轉發給前端安裝進度介面。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# 不論主控台預設字碼（如 Windows Git Bash 的 cp1252）為何，JSON Lines
# 進度一律以 UTF-8 輸出，避免繁中訊息觸發 UnicodeEncodeError。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# 與 README 中記錄的上游版本一致；升級需同步更新 SHA。
BREEZE_COMMIT = "59da766e9156fed409666d15c1879176baac1fa0"
BREEZE_ARCHIVE = (
    "https://github.com/thc1006/breeze-asr-taigi/archive/"
    f"{BREEZE_COMMIT}.tar.gz"
)
MODEL_ID = "paulpengtw/faster-whisper-Breeze-ASR-26"


LOG_FILE = None


def emit(phase: str, message: str, fraction: float | None = None) -> None:
    line = json.dumps(
        {"phase": phase, "message": message, "fraction": fraction},
        ensure_ascii=False,
    )
    print(line, flush=True)
    if LOG_FILE is not None:
        LOG_FILE.write(line + "\n")
        LOG_FILE.flush()


def run_pip(args: list[str], phase: str, fatal: bool = True) -> bool:
    cmd = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--progress-bar",
        "off",
        "--disable-pip-version-check",
        "--no-input",
        *args,
    ]
    emit(phase, "執行 pip 安裝（輸出即時刷新）…")
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = raw.rstrip()
        if line:
            emit(phase, line[:240])
    code = proc.wait()
    if code != 0:
        if fatal:
            emit(phase, f"pip 結束代碼 {code}")
            sys.exit(code)
        emit(phase, f"警告：pip 結束代碼 {code}，將略過此步驟並繼續。")
        return False
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True, type=Path)
    parser.add_argument("--requirements", required=True, type=Path)
    parser.add_argument("--gpu-requirements", required=True, type=Path)
    parser.add_argument("--gpu", action="store_true")
    parser.add_argument("--skip-model", action="store_true")
    args = parser.parse_args()

    log_dir = args.base / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    global LOG_FILE
    LOG_FILE = open(log_dir / "bootstrap.log", "a", encoding="utf-8")
    LOG_FILE.write(f"\n===== bootstrap run =====" + "\n")

    # 模型快取固定在應用資料目錄內（Rust 端亦會設定 HF_HOME，這裡保底）。
    os.environ.setdefault("HF_HOME", str(args.base / "models"))
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    emit("deps", "升級 pip…")
    run_pip(["--upgrade", "pip"], "deps", fatal=False)

    emit("deps", "安裝轉錄引擎依賴（首次需數分鐘）…", 0.05)
    run_pip(["-r", str(args.requirements)], "deps")

    if args.gpu:
        emit("gpu", "偵測到 NVIDIA GPU，安裝 CUDA 執行期函式庫…", 0.55)
        run_pip(["-r", str(args.gpu_requirements)], "gpu", fatal=False)

    emit("deps", "安裝 breeze-asr-taigi（釘定版本）…", 0.7)
    run_pip(["--no-deps", BREEZE_ARCHIVE], "deps")

    # 驗證關鍵模組可匯入，提早暴露環境問題。
    emit("deps", "驗證安裝結果…", 0.78)
    check = subprocess.run(
        [
            sys.executable,
            "-c",
            "import faster_whisper, taigi_asr, imageio_ffmpeg; "
            "from taigi_asr.formatters import to_srt; print('ok')",
        ],
        capture_output=True,
        text=True,
    )
    if check.returncode != 0 or "ok" not in check.stdout:
        emit("deps", f"模組驗證失敗：{check.stderr.strip()[:400]}")
        sys.exit(1)

    if args.skip_model:
        emit("model", "已略過模型預載。", 1.0)
        return

    emit("model", "下載 Breeze-ASR-26 模型（約 2.9 GB，只此一次，請耐心等待）…", 0.82)
    try:
        from huggingface_hub import snapshot_download

        path = snapshot_download(MODEL_ID, max_workers=4)
        emit("model", f"模型就緒：{path}", 1.0)
    except Exception as exc:  # 模型可在首次轉錄時重試下載
        emit("model", f"模型預載失敗（稍後可重試）：{exc}")
        sys.exit(2)

    emit("done", "環境準備完成", 1.0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        import traceback

        emit("error", "環境安裝程式發生未預期錯誤：\n" + traceback.format_exc()[-1500:])
        sys.exit(1)
