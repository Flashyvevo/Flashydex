"""Environment-driven runtime configuration (FLASHYDEX_RECOG_*)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = SERVICE_ROOT.parents[1]
DEV_ORIGINS = "https://localhost:3200,https://127.0.0.1:3200,https://10.0.0.4:3200"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _env(name: str, default: str = "") -> str:
    return os.environ.get(f"FLASHYDEX_RECOG_{name}", default)


@dataclass(frozen=True, slots=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8900
    token: str = ""
    allowed_origins: tuple[str, ...] = field(default_factory=tuple)
    data_dir: Path = SERVICE_ROOT / "data"
    catalog_dir: Path = REPO_ROOT / ".agent" / "metrics" / "packs"
    ort_threads: int = 0  # 0 = ORT default (all cores)
    log_level: str = "INFO"
    langs: tuple[str, ...] = ("en", "ja")

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def index_dir(self) -> Path:
        return self.data_dir / "index"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def is_loopback(self) -> bool:
        return self.host in LOOPBACK_HOSTS

    @classmethod
    def from_env(cls) -> Settings:
        origins = tuple(o.strip() for o in _env("ALLOWED_ORIGINS", DEV_ORIGINS).split(",") if o.strip())
        return cls(
            host=_env("HOST", "127.0.0.1"),
            port=int(_env("PORT", "8900")),
            token=_env("TOKEN", ""),
            allowed_origins=origins,
            data_dir=Path(_env("DATA_DIR", str(SERVICE_ROOT / "data"))),
            catalog_dir=Path(_env("CATALOG_DIR", str(REPO_ROOT / ".agent" / "metrics" / "packs"))),
            ort_threads=int(_env("ORT_THREADS", "0")),
            log_level=_env("LOG_LEVEL", "INFO").upper(),
        )
