"""轉錄任務佇列：單 worker、模型常駐、狀態通過 EventBus 即時推送。"""

from __future__ import annotations

import queue
import threading
import time
import uuid
from pathlib import Path

from pydantic import BaseModel, Field

from taigi_asr.audio import AudioConverter
from taigi_asr.formatters import to_json, to_srt, to_txt, to_vtt

from .events import EventBus
from .runner import HardwareSpec, JobCancelled, ModelRunner, detect_hardware
from .settings import SettingsStore

# 進度條分段：解碼 2% → 載模型 3% → 轉錄 95% → 寫檔 100%。
P_CONVERTED = 0.02
P_LOADED = 0.03
P_TRANSCRIBE_END = 0.95

VALID_SUFFIXES = {
    ".mp3", ".m4a", ".wav", ".flac", ".ogg", ".webm", ".mp4", ".mkv",
    ".aac", ".opus", ".wma", ".mov", ".avi", ".aiff", ".3gp", ".ts",
}


class Segment(BaseModel):
    start: float
    end: float
    text: str


class Job(BaseModel):
    id: str
    input_path: str
    status: str = "queued"  # queued|converting|loading|transcribing|writing|done|error|cancelled
    progress: float = 0.0
    message: str = "等待中"
    created_at: float
    started_at: float | None = None
    finished_at: float | None = None
    duration: float | None = None
    outputs: list[str] = Field(default_factory=list)
    segments: list[Segment] = Field(default_factory=list)
    error: str | None = None


class JobManager:
    def __init__(self, base: Path, bus: EventBus, settings_store: SettingsStore) -> None:
        self.base = base
        self.bus = bus
        self.settings_store = settings_store

        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._cancel: dict[str, threading.Event] = {}

        self._spec: HardwareSpec | None = None
        self._runner: ModelRunner | None = None
        self._runner_lock = threading.Lock()

        self._thread = threading.Thread(target=self._worker_loop, name="taigi-worker", daemon=True)
        self._thread.start()

        # 硬體偵測便宜（NVML + CT2 自檢），啟動時背景跑一次供 UI 顯示，
        # 不必等到第一個任務。
        threading.Thread(target=self._detect_spec_once, daemon=True).start()

    # ---------- 查詢 / 提交 ----------

    def list_jobs(self) -> list[Job]:
        with self._lock:
            return list(self._jobs.values())

    def submit_paths(self, paths: list[str]) -> list[Job]:
        created: list[Job] = []
        now = time.time()
        with self._lock:
            active_paths = {
                j.input_path for j in self._jobs.values() if j.status in ("queued", "converting", "loading", "transcribing", "writing")
            }
            for raw in paths:
                p = Path(raw)
                if not p.is_file():
                    raise FileNotFoundError(f"找不到檔案：{raw}")
                if str(p) in active_paths:
                    continue
                job = Job(id=uuid.uuid4().hex[:12], input_path=str(p), created_at=now)
                self._jobs[job.id] = job
                self._cancel[job.id] = threading.Event()
                active_paths.add(str(p))
                created.append(job)
        for job in created:
            self._publish(job)
            self._queue.put(job.id)
        return created

    def request_cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job.status in ("done", "error", "cancelled"):
                return False
        flag = self._cancel.get(job_id)
        if flag:
            flag.set()
        return True

    def request_model_load(self) -> bool:
        if self._runner is not None and self._runner.loaded:
            return False
        threading.Thread(target=self._ensure_runner, args=(None,), daemon=True).start()
        return True

    def hardware(self) -> HardwareSpec | None:
        return self._spec

    def runner_loaded(self) -> bool:
        return self._runner is not None and self._runner.loaded

    def model_id(self) -> str:
        return self._runner._model_id if self._runner else ""

    # ---------- 內部 ----------

    def _publish(self, job: Job) -> None:
        self.bus.publish({"type": "job", "job": job.model_dump()})

    def _system(self, message: str, **extra) -> None:
        self.bus.publish({"type": "system", "message": message, **extra})

    def _set(self, job: Job, **changes) -> None:
        for k, v in changes.items():
            setattr(job, k, v)
        self._publish(job)

    def _detect_spec_once(self) -> HardwareSpec:
        with self._runner_lock:
            if self._spec is not None:
                return self._spec
            self._system("偵測硬體…", runner_state="detecting")
            spec = detect_hardware()
            self._spec = spec
            if self._runner is None:
                self._runner = ModelRunner(spec)
        self._system(
            f"使用 {'GPU：' + spec.gpu_name + f'（{spec.vram_gb:.1f} GB）' if spec.device == 'cuda' else 'CPU'} 模式",
            runner_state="idle",
            hardware={
                "device": spec.device,
                "compute_type": spec.compute_type,
                "batch_size": spec.batch_size,
                "gpu_name": spec.gpu_name,
                "vram_gb": spec.vram_gb,
            },
        )
        return spec

    def _ensure_runner(self, job: Job | None) -> ModelRunner:
        spec = self._detect_spec_once()
        with self._runner_lock:
            runner = self._runner or ModelRunner(spec)
            self._runner = runner
            if not runner.loaded:
                if job is not None:
                    self._set(job, status="loading", progress=P_LOADED, message="載入辨識模型（首次需從快取讀取約 2.9 GB）…")
                else:
                    self._system("載入辨識模型…", runner_state="loading")
                runner.load(on_log=lambda m: self._system(m, runner_state="loading"))
                self._system("模型就緒", runner_state="loaded")
            return runner

    def _worker_loop(self) -> None:
        while True:
            job_id = self._queue.get()
            try:
                self._process(job_id)
            except Exception as exc:  # 最後防線，worker 絕不能死
                with self._lock:
                    job = self._jobs.get(job_id)
                if job:
                    self._set(job, status="error", error=f"內部錯誤：{exc}", message="失敗")
            finally:
                self._queue.task_done()

    def _process(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
        cancel = self._cancel[job_id]

        if cancel.is_set():
            self._set(job, status="cancelled", message="已取消", finished_at=time.time())
            return

        settings = self.settings_store.get()
        formats = settings.normalized_formats()
        source = Path(job.input_path)
        if source.suffix.lower() not in VALID_SUFFIXES:
            self._system(f"提示：{source.name} 的副檔名不在已知清單，仍會嘗試以 ffmpeg 解碼。")

        job.started_at = time.time()
        wav_path: Path | None = None
        try:
            self._set(job, status="converting", progress=0.01, message="以 ffmpeg 解碼音訊…")
            wav_path, duration = AudioConverter.convert(source)
            job.duration = duration or None
            self._set(job, progress=P_CONVERTED, message="解碼完成")

            if cancel.is_set():
                raise JobCancelled()

            runner = self._ensure_runner(job)

            self._set(job, status="transcribing", progress=P_LOADED, message="台語辨識中…")
            last_emit = [0.0]

            def on_progress(frac: float) -> None:
                mapped = P_LOADED + frac * (P_TRANSCRIBE_END - P_LOADED)
                job.progress = round(mapped, 4)
                now = time.time()
                if now - last_emit[0] > 0.25 or frac >= 0.98:
                    last_emit[0] = now
                    self._publish(job)

            segments = runner.transcribe(
                wav_path,
                duration,
                beam_size=settings.beam_size,
                word_timestamps=settings.word_timestamps,
                progress=on_progress,
                cancelled=cancel,
            )
            if cancel.is_set():
                raise JobCancelled()

            job.segments = [Segment(start=s.start_time, end=s.end_time, text=s.text) for s in segments]
            job.progress = P_TRANSCRIBE_END

            self._set(job, status="writing", message="輸出字幕檔…")
            out_dir = settings.effective_output_dir(source)
            out_dir.mkdir(parents=True, exist_ok=True)
            outputs: list[str] = []
            meta = {
                "engine": "faster-whisper-Breeze-ASR-26",
                "device": runner.spec.device,
                "compute_type": runner.spec.compute_type,
                "beam_size": settings.beam_size,
                "word_timestamps": settings.word_timestamps,
                "duration": duration,
                "source": str(source),
            }
            writers = {
                "srt": to_srt,
                "vtt": to_vtt,
                "txt": to_txt,
                "json": lambda segs: to_json(segs, meta=meta),
            }
            for fmt in formats:
                target = out_dir / f"{source.stem}.{fmt}"
                target.write_text(writers[fmt](segments), encoding="utf-8")
                outputs.append(str(target))

            self._set(
                job,
                status="done",
                progress=1.0,
                message=f"完成（{len(segments)} 句）",
                outputs=outputs,
                finished_at=time.time(),
            )
        except JobCancelled:
            self._set(job, status="cancelled", message="已取消", finished_at=time.time())
        except FileNotFoundError as exc:
            self._set(job, status="error", error=str(exc), message="失敗", finished_at=time.time())
        except Exception as exc:
            hint = str(exc)
            if "ffmpeg" in hint.lower() or "decoder" in hint.lower():
                hint += "（音訊解碼失敗，請確認檔案可正常播放）"
            self._set(job, status="error", error=hint, message="失敗", finished_at=time.time())
        finally:
            if wav_path is not None:
                AudioConverter.cleanup(wav_path)
