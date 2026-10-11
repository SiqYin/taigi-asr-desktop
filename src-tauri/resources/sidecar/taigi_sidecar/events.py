"""跨執行緒事件匯流排：轉錄執行緒 → asyncio SSE 訂閱者。"""

from __future__ import annotations

import asyncio
import threading


class EventBus:
    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subs: set[asyncio.Queue] = set()
        self._lock = threading.Lock()

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=512)
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._subs.discard(q)

    def publish(self, event: dict) -> None:
        loop = self._loop
        if loop is None:
            return

        def _push() -> None:
            with self._lock:
                subs = list(self._subs)
            for q in subs:
                try:
                    if q.full():
                        q.get_nowait()
                    q.put_nowait(event)
                except Exception:
                    pass

        loop.call_soon_threadsafe(_push)
