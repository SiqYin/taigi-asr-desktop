"""使用者設定（輸出格式、beam size、逐字時間戳記、輸出目錄）。"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from pydantic import BaseModel, Field

SUPPORTED_FORMATS = ("srt", "vtt", "txt", "json")


class Settings(BaseModel):
    formats: list[str] = Field(default_factory=lambda: ["srt"])
    beam_size: int = 5
    word_timestamps: bool = False
    output_dir: str = ""  # 空字串 = 輸出到來源檔旁邊

    def normalized_formats(self) -> list[str]:
        seen: list[str] = []
        for f in self.formats:
            if f in SUPPORTED_FORMATS and f not in seen:
                seen.append(f)
        return seen or ["srt"]

    def effective_output_dir(self, source: Path) -> Path:
        if self.output_dir and Path(self.output_dir).is_dir():
            return Path(self.output_dir)
        return source.parent


def _atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


class SettingsStore:
    def __init__(self, base: Path) -> None:
        self.path = base / "config.json"
        self._settings = Settings()
        self.load()

    def load(self) -> Settings:
        if self.path.exists():
            try:
                self._settings = Settings(**json.loads(self.path.read_text(encoding="utf-8")))
            except Exception:
                self._settings = Settings()
        return self._settings

    def get(self) -> Settings:
        return self._settings

    def update(self, values: dict) -> Settings:
        updated = self._settings.model_copy(update=values)
        _atomic_write_json(self.path, updated.model_dump())
        self._settings = updated
        return updated
