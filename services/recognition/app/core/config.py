"""Environment-driven runtime configuration (FLASHYDEX_RECOG_*)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from app.core import constants

SERVICE_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = SERVICE_ROOT.parents[1]
DEFAULT_ORIGINS = (
    "https://flashydex.netlify.app,https://localhost:3200,https://127.0.0.1:3200,https://10.0.0.4:3200,"
    "http://127.0.0.1:3201,http://127.0.0.1:3203,http://localhost:3201,http://localhost:3203"
)
DEFAULT_ORIGIN_REGEX = r"^https://[a-z0-9-]+--flashydex\.netlify\.app$"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _env(name: str, default: str = "") -> str:
    return os.environ.get(f"FLASHYDEX_RECOG_{name}", default)


@dataclass(frozen=True, slots=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8900
    token: str = ""
    allowed_origins: tuple[str, ...] = field(default_factory=lambda: tuple(DEFAULT_ORIGINS.split(",")))
    allowed_origin_regex: str = DEFAULT_ORIGIN_REGEX
    rate_per_min: int = constants.RATE_LIMIT_PER_MIN
    rate_per_day: int = constants.RATE_LIMIT_PER_DAY
    rate_global_per_hour: int = constants.RATE_LIMIT_GLOBAL_PER_HOUR
    max_concurrent: int = constants.MAX_CONCURRENT_IDENTIFY
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

    def origin_allowed(self, origin: str) -> bool:
        if not origin:
            return False
        if origin in self.allowed_origins:
            return True
        return bool(self.allowed_origin_regex and re.fullmatch(self.allowed_origin_regex, origin))

    @property
    def is_loopback(self) -> bool:
        return self.host in LOOPBACK_HOSTS

    @classmethod
    def from_env(cls) -> Settings:
        origins = tuple(o.strip() for o in _env("ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",") if o.strip())
        return cls(
            host=_env("HOST", "127.0.0.1"),
            port=int(_env("PORT", "8900")),
            token=_env("TOKEN", ""),
            allowed_origins=origins,
            allowed_origin_regex=_env("ALLOWED_ORIGIN_REGEX", DEFAULT_ORIGIN_REGEX),
            rate_per_min=int(_env("RATE_PER_MIN", str(constants.RATE_LIMIT_PER_MIN))),
            rate_per_day=int(_env("RATE_PER_DAY", str(constants.RATE_LIMIT_PER_DAY))),
            rate_global_per_hour=int(_env("RATE_GLOBAL_PER_HOUR", str(constants.RATE_LIMIT_GLOBAL_PER_HOUR))),
            max_concurrent=int(_env("MAX_CONCURRENT", str(constants.MAX_CONCURRENT_IDENTIFY))),
            data_dir=Path(_env("DATA_DIR", str(SERVICE_ROOT / "data"))),
            catalog_dir=Path(_env("CATALOG_DIR", str(REPO_ROOT / ".agent" / "metrics" / "packs"))),
            ort_threads=int(_env("ORT_THREADS", "0")),
            log_level=_env("LOG_LEVEL", "INFO").upper(),
        )
