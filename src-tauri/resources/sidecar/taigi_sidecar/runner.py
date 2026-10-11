"""辨識引擎封裝：硬體探測 + faster-whisper (CT2) 模型生命週期。

只走 breeze-asr-taigi 的「主力路徑」Faster-Whisper 引擎（RTX 3050 4GB 可跑、
純 CPU 亦可），顯存決策表與上游 router 一致，但不需要 torch：
VRAM 來自 NVML，CUDA 可用性來自 CTranslate2 自檢。
"""

from __future__ import annotations

import os
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from taigi_asr.segments import TimestampedSegment

_ENV_READY = False


def prepare_native_env() -> None:
    """讓 imageio-ffmpeg 附帶的 ffmpeg、pip 安裝的 CUDA DLL 可被找到。

    必須在 import ctranslate2 / pydub 之前執行。
    """
    global _ENV_READY
    if _ENV_READY:
        return

    extra_dirs: list[str] = []
    try:
        import imageio_ffmpeg

        extra_dirs.append(os.path.dirname(imageio_ffmpeg.get_ffmpeg_exe()))
    except Exception:
        pass

    # nvidia-cublas-cu12 / nvidia-cudnn-cu12 把 DLL 裝在
    # site-packages/nvidia/<pkg>/bin（Windows）或 ../lib（Linux）。
    for root in [*sys.path, os.path.dirname(sys.executable)]:
        nv = Path(root) / "nvidia"
        if nv.is_dir():
            for sub in nv.iterdir():
                for candidate in (sub / "bin", sub / "lib"):
                    if candidate.is_dir():
                        extra_dirs.append(str(candidate))

    if extra_dirs:
        os.environ["PATH"] = os.pathsep.join(extra_dirs) + os.pathsep + os.environ.get("PATH", "")
    if sys.platform == "win32":
        for d in extra_dirs:
            try:
                os.add_dll_directory(d)  # type: ignore[attr-defined]
            except OSError:
                pass
    _ENV_READY = True


@dataclass(frozen=True)
class HardwareSpec:
    device: str  # "cuda" | "cpu"
    compute_type: str
    batch_size: int
    cpu_threads: int
    gpu_name: str
    vram_gb: float


def detect_hardware() -> HardwareSpec:
    prepare_native_env()
    cpu_threads = os.cpu_count() or 4

    cuda_ok = False
    try:
        import ctranslate2

        cuda_ok = ctranslate2.get_cuda_device_count() > 0
    except Exception:
        cuda_ok = False

    gpu_name = "CPU"
    vram_gb = 0.0
    if cuda_ok:
        try:
            from pynvml import (
                nvmlDeviceGetHandleByIndex,
                nvmlDeviceGetMemoryInfo,
                nvmlDeviceGetName,
                nvmlInit,
                nvmlShutdown,
            )

            nvmlInit()
            handle = nvmlDeviceGetHandleByIndex(0)
            gpu_name = nvmlDeviceGetName(handle)
            if isinstance(gpu_name, bytes):
                gpu_name = gpu_name.decode("utf-8", "replace")
            vram_gb = round(nvmlDeviceGetMemoryInfo(handle).total / (1024**3), 2)
            nvmlShutdown()
        except Exception:
            # CT2 看得到 CUDA 但 NVML 失敗：視為 4GB 級卡，走最穩的 int8_float16。
            gpu_name = "NVIDIA GPU (NVML 無法讀取顯存)"
            vram_gb = 4.0

    if not cuda_ok:
        return HardwareSpec("cpu", "int8", 1, cpu_threads, gpu_name, 0.0)

    # 與 breeze-asr-taigi EngineRouter._fw_spec 相同的分檔。
    if vram_gb >= 14.0:
        return HardwareSpec("cuda", "float16", 8, cpu_threads, gpu_name, vram_gb)
    if vram_gb >= 3.5:
        return HardwareSpec("cuda", "int8_float16", 4, cpu_threads, gpu_name, vram_gb)
    return HardwareSpec("cuda", "int8_float16", 2, cpu_threads, gpu_name, vram_gb)


class JobCancelled(Exception):
    """使用者在轉錄途中取消。"""


class ModelRunner:
    """模型常駐：整個 sidecar 生命週期只載入一次。"""

    def __init__(self, spec: HardwareSpec) -> None:
        self.spec = spec
        self._batched = None
        self._model_id = ""
        self._lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._batched is not None

    def load(self, on_log: Callable[[str], None] | None = None) -> None:
        with self._lock:
            if self._batched is not None:
                return
            prepare_native_env()
            from faster_whisper import BatchedInferencePipeline, WhisperModel
            from taigi_asr.config import FASTER_WHISPER_MODEL_ID

            self._model_id = FASTER_WHISPER_MODEL_ID
            if on_log:
                on_log(f"載入模型 {FASTER_WHISPER_MODEL_ID}（{self.spec.device}）…")
            model = WhisperModel(
                FASTER_WHISPER_MODEL_ID,
                device=self.spec.device,
                compute_type=self.spec.compute_type,
                cpu_threads=self.spec.cpu_threads,
            )
            self._batched = BatchedInferencePipeline(model=model)
            if on_log:
                on_log("模型載入完成。")

    def transcribe(
        self,
        wav_path: Path,
        duration: float,
        *,
        beam_size: int,
        word_timestamps: bool,
        progress: Callable[[float], None],
        cancelled: threading.Event,
    ) -> list[TimestampedSegment]:
        if self._batched is None:
            raise RuntimeError("模型尚未載入")

        from taigi_asr.config import (
            DEFAULT_LANGUAGE,
            DEFAULT_VAD_MIN_SILENCE_MS,
            DEFAULT_VAD_SPEECH_PAD_MS,
        )

        def on_segment(seg) -> TimestampedSegment:
            start = float(seg.start) if seg.start is not None else 0.0
            end = float(seg.end) if seg.end is not None else start + 1.0
            return TimestampedSegment(start_time=start, end_time=end, text=(seg.text or "").strip())

        segments_iter, _info = self._batched.transcribe(
            str(wav_path),
            batch_size=self.spec.batch_size,
            language=DEFAULT_LANGUAGE,
            beam_size=beam_size,
            vad_filter=True,
            vad_parameters={
                "min_silence_duration_ms": DEFAULT_VAD_MIN_SILENCE_MS,
                "speech_pad_ms": DEFAULT_VAD_SPEECH_PAD_MS,
            },
            word_timestamps=word_timestamps,
            without_timestamps=False,
        )

        out: list[TimestampedSegment] = []
        for seg in segments_iter:
            if cancelled.is_set():
                raise JobCancelled()
            item = on_segment(seg)
            if item.text:
                out.append(item)
            if duration > 0:
                progress(min(0.98, item.end_time / duration))
        return out
