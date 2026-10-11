"""FastAPI 應用：本機 loopback JSON API + SSE 事件流。"""

from __future__ import annotations

import asyncio
import hmac
import json
from dataclasses import asdict
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ValidationError

from .events import EventBus
from .jobs import JobManager
from .settings import SUPPORTED_FORMATS, Settings, SettingsStore


class JobsRequest(BaseModel):
    paths: list[str]


class CancelRequest(BaseModel):
    id: str


def create_app(base: Path, expected_token: str) -> FastAPI:
    app = FastAPI(title="Taigi ASR Sidecar", docs_url=None, redoc_url=None, openapi_url=None)
    bus = EventBus()
    settings_store = SettingsStore(base)
    manager = JobManager(base, bus, settings_store)

    def require_token(
        x_taigi_token: str | None = Header(default=None),
        token: str | None = Query(default=None),
    ) -> None:
        # 注意：參數名 token 會遮蔽外層變數，比對值必須用 expected_token。
        supplied = x_taigi_token or token or ""
        if not hmac.compare_digest(supplied, expected_token):
            raise HTTPException(status_code=403, detail="invalid token")

    @app.on_event("startup")
    async def _bind_bus() -> None:
        bus.bind_loop(asyncio.get_running_loop())

    @app.get("/health", dependencies=[Depends(require_token)])
    async def health() -> dict:
        return {"ok": True, "service": "taigi-asr-sidecar"}

    @app.get("/api/system", dependencies=[Depends(require_token)])
    async def system_info() -> dict:
        spec = manager.hardware()
        return {
            "hardware": asdict(spec) if spec else None,
            "model_loaded": manager.runner_loaded(),
            "model_id": manager.model_id(),
            "formats": list(SUPPORTED_FORMATS),
        }

    @app.get("/api/settings", dependencies=[Depends(require_token)])
    async def get_settings() -> dict:
        return settings_store.get().model_dump()

    @app.post("/api/settings", dependencies=[Depends(require_token)])
    async def post_settings(body: dict) -> dict:
        current = settings_store.get()
        allowed = {"formats", "beam_size", "word_timestamps", "output_dir"}
        unknown = set(body) - allowed
        if unknown:
            raise HTTPException(status_code=400, detail=f"未知設定項：{sorted(unknown)}")
        try:
            merged = Settings(**{**current.model_dump(), **body})
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail=exc.errors()) from exc
        bad = [f for f in merged.formats if f not in SUPPORTED_FORMATS]
        if bad:
            raise HTTPException(status_code=422, detail=f"不支援的格式：{bad}")
        if not 1 <= merged.beam_size <= 15:
            raise HTTPException(status_code=422, detail="beam_size 須介於 1–15")
        if merged.output_dir and not Path(merged.output_dir).is_dir():
            raise HTTPException(status_code=422, detail="輸出目錄不存在")
        saved = settings_store.update(merged.model_dump())
        bus.publish({"type": "settings", "settings": saved.model_dump()})
        return saved.model_dump()

    @app.post("/api/jobs", dependencies=[Depends(require_token)])
    async def create_jobs(req: JobsRequest) -> dict:
        if not req.paths:
            raise HTTPException(status_code=400, detail="未提供檔案")
        try:
            jobs = manager.submit_paths(req.paths)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"jobs": [j.model_dump() for j in jobs]}

    @app.get("/api/jobs", dependencies=[Depends(require_token)])
    async def list_jobs() -> dict:
        return {"jobs": [j.model_dump() for j in manager.list_jobs()]}

    @app.post("/api/jobs/cancel", dependencies=[Depends(require_token)])
    async def cancel_job(req: CancelRequest) -> dict:
        ok = manager.request_cancel(req.id)
        if not ok:
            raise HTTPException(status_code=404, detail="任務不存在或已結束")
        return {"ok": True}

    @app.post("/api/model/load", dependencies=[Depends(require_token)])
    async def preload_model() -> dict:
        started = manager.request_model_load()
        return {"started": started}

    @app.get("/api/events", dependencies=[Depends(require_token)])
    async def events() -> StreamingResponse:
        async def stream():
            q = bus.subscribe()
            try:
                hello = {
                    "type": "hello",
                    "jobs": [j.model_dump() for j in manager.list_jobs()],
                    "settings": settings_store.get().model_dump(),
                    "hardware": asdict(manager.hardware()) if manager.hardware() else None,
                    "model_loaded": manager.runner_loaded(),
                }
                yield f"data: {json.dumps(hello, ensure_ascii=False)}\n\n"
                while True:
                    try:
                        event = await asyncio.wait_for(q.get(), timeout=15.0)
                        yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": ping\n\n"
            finally:
                bus.unsubscribe(q)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app
