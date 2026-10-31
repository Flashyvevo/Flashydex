"""Reference image fetch + per-card cache (polite: bounded concurrency, backoff)."""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from pathlib import Path

import httpx

from app.core import constants
from app.models import CardRef

logger = logging.getLogger(__name__)
_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def safe_name(card_id: str) -> str:
    return _SAFE.sub("_", card_id)


def image_path(cache_dir: Path, card: CardRef) -> Path:
    return cache_dir / "images" / card.language / f"{safe_name(card.card_id)}.{constants.IMAGE_EXTENSION}"


def image_source_url(card: CardRef) -> str:
    return f"{card.image_url}/{constants.IMAGE_QUALITY}.{constants.IMAGE_EXTENSION}"


class PermanentFetchError(RuntimeError):
    """404/410 etc: retrying will not help."""


class ImageFetcher:
    """Thread-safe downloader with retries and exponential backoff."""

    def __init__(self, cache_dir: Path, client: httpx.Client | None = None) -> None:
        self._cache_dir = cache_dir
        self._client = client or httpx.Client(
            timeout=constants.HTTP_TIMEOUT_SECONDS,
            limits=httpx.Limits(max_connections=constants.DOWNLOAD_CONCURRENCY * 2),
            headers={"User-Agent": "flashydex-recognition-index-build/0.1"},
            follow_redirects=True,
        )
        self._lock = threading.Lock()

    def ensure(self, card: CardRef) -> Path:
        """Return the cached image path, downloading it when absent/empty."""
        path = image_path(self._cache_dir, card)
        if path.is_file() and path.stat().st_size > 0:
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        url = image_source_url(card)
        last: Exception | None = None
        for attempt in range(constants.DOWNLOAD_RETRIES):
            try:
                resp = self._client.get(url)
                if resp.status_code in (404, 410):
                    raise PermanentFetchError(f"{resp.status_code} {url}")
                if resp.status_code == 429 or resp.status_code >= 500:
                    retry_after = resp.headers.get("retry-after", "")
                    if retry_after.isdigit():
                        time.sleep(min(float(retry_after), 30.0))
                    raise RuntimeError(f"transient status {resp.status_code}")
                resp.raise_for_status()
                if not resp.content:
                    raise RuntimeError("empty body")
                tmp = path.with_suffix(path.suffix + f".{os.getpid()}.{threading.get_ident()}.part")
                tmp.write_bytes(resp.content)
                os.replace(tmp, path)
                return path
            except PermanentFetchError:
                raise
            except Exception as error:  # noqa: BLE001
                last = error
                time.sleep(constants.DOWNLOAD_BACKOFF_SECONDS * (2**attempt))
        raise RuntimeError(f"download failed after retries: {url}: {last}")

    def close(self) -> None:
        self._client.close()
