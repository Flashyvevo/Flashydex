"""Index build: model fetch, resumable per-card cache, batched embedding, atomic write.

Resumable: every downloaded image and every computed feature set is cached per card under
``data/cache``; a re-run only does the missing work, then re-assembles the index.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections import deque
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

import cv2
import httpx
import numpy as np

from app.core import constants
from app.core.config import Settings
from app.core.sysinfo import peak_rss_mb
from app.index.features import CardTensors, embed_prepared, prepare_card
from app.index.store import sha256_file, write_index
from app.models import CardRef
from app.reference.catalog import find_pack, read_cards
from app.reference.images import ImageFetcher, PermanentFetchError, safe_name
from app.signals.embedding import ModelMissingError, OnnxEmbedder
from app.vision.rectify import center_crop_to_card

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- model
def ensure_model(settings: Settings) -> Path:
    """Download ``onnx-community/dinov2-small`` once; verify size + SHA-256. Never substitutes."""
    path = settings.models_dir / constants.EMBED_MODEL_FILE
    if path.is_file() and sha256_file(path) == constants.EMBED_MODEL_SHA256:
        return path
    settings.models_dir.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    logger.info("downloading %s", constants.EMBED_MODEL_URL)
    digest = hashlib.sha256()
    try:
        with httpx.stream("GET", constants.EMBED_MODEL_URL, follow_redirects=True, timeout=120.0) as resp:
            if resp.status_code in (401, 403):
                raise ModelMissingError(f"Hugging Face requires auth for the model ({resp.status_code})")
            resp.raise_for_status()
            with tmp.open("wb") as out:
                for chunk in resp.iter_bytes(1 << 20):
                    out.write(chunk)
                    digest.update(chunk)
    except httpx.HTTPError as error:
        raise ModelMissingError(f"model download failed: {error}") from error
    if digest.hexdigest() != constants.EMBED_MODEL_SHA256:
        tmp.unlink(missing_ok=True)
        raise ModelMissingError(f"model sha256 mismatch ({digest.hexdigest()})")
    tmp.replace(path)
    return path


# --------------------------------------------------------------------------- feature cache
def _feat_id(embedder: OnnxEmbedder) -> str:
    """Cache validity key: a model or hash-algorithm change invalidates cached features."""
    return f"{embedder.identifier}|{constants.HASH_VERSION}"


def _feat_path(cache_dir: Path, card: CardRef) -> Path:
    return cache_dir / "feat" / card.language / f"{safe_name(card.card_id)}.npz"


def _load_feat(path: Path, embedder_id: str, url: str | None) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    if not path.is_file():
        return None
    try:
        with np.load(path, allow_pickle=False) as z:
            if str(z["emb_id"]) != embedder_id or str(z["url"]) != (url or ""):
                return None
            return z["full"], z["art"], z["hashes"]
    except Exception:  # noqa: BLE001 - torn/corrupt cache entry: recompute
        return None


def _save_feat(path: Path, embedder_id: str, url: str | None, full, art, hashes) -> None:  # noqa: ANN001
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp.npz")
    np.savez(tmp, full=full.astype(np.float16), art=art.astype(np.float16), hashes=hashes,
             emb_id=np.array(embedder_id), url=np.array(url or ""))
    tmp.replace(path)


def _decode_reference(path: Path) -> np.ndarray:
    data = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if data is None:
        raise ValueError(f"undecodable reference image {path}")
    return cv2.cvtColor(data, cv2.COLOR_BGR2RGB)


# --------------------------------------------------------------------------- build
ProgressFn = Callable[[dict], None]


def build_language(
    cards: list[CardRef],
    *,
    language: str,
    settings: Settings,
    embedder: OnnxEmbedder,
    fetcher: ImageFetcher,
    catalog_version: str,
    out_dir: Path | None = None,
    workers: int = constants.DOWNLOAD_CONCURRENCY,
    progress: ProgressFn | None = None,
    shard: tuple[int, int] | None = None,
) -> dict:
    """Build (or resume) the index for ``cards`` (all of ``language``). Returns the manifest."""
    started = time.monotonic()
    cache_dir = settings.cache_dir
    out_dir = out_dir or settings.index_dir / language
    workers = max(1, min(workers, constants.DOWNLOAD_CONCURRENCY))

    todo = [c for c in cards if _load_feat(_feat_path(cache_dir, c), _feat_id(embedder), c.image_url) is None]
    if shard:  # feature-cache-only worker: card i belongs to shard (i % n); no index is written
        todo = [c for i, c in enumerate(todo) if i % shard[1] == shard[0]]
    cached = len(cards) - len(todo)
    logger.info("[%s] %d cards, %d cached, %d to process", language, len(cards), cached, len(todo))
    failures: dict[str, str] = {}

    def fetch(card: CardRef) -> Path:
        return fetcher.ensure(card)

    done = 0
    pending: deque[tuple[CardRef, Future[Path]]] = deque()
    batch: list[tuple[CardRef, CardTensors]] = []
    todo_iter = iter(todo)

    def flush() -> None:
        if not batch:
            return
        items = [t for _, t in batch]
        full, art = embed_prepared(embedder, items)
        for i, (card, tensors) in enumerate(batch):
            _save_feat(_feat_path(cache_dir, card), _feat_id(embedder), card.image_url,
                       full[i], art[i], tensors.hashes)
        batch.clear()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        def refill() -> None:
            while len(pending) < workers * 6:
                nxt = next(todo_iter, None)
                if nxt is None:
                    return
                pending.append((nxt, pool.submit(fetch, nxt)))

        refill()
        while pending:
            card, fut = pending.popleft()
            refill()
            try:
                path = fut.result()
                tensors = prepare_card(center_crop_to_card(_decode_reference(path)))
                batch.append((card, tensors))
            except PermanentFetchError as error:
                failures[card.card_id] = str(error)
            except Exception as error:  # noqa: BLE001
                failures[card.card_id] = f"{type(error).__name__}: {error}"
            if len(batch) >= constants.EMBED_BATCH_CARDS:
                flush()
            done += 1
            if progress and (done % 250 == 0 or done == len(todo)):
                elapsed = time.monotonic() - started
                rate = done / elapsed if elapsed else 0.0
                progress({"language": language, "done": done, "total": len(todo), "failures": len(failures),
                          "cardsPerSec": round(rate, 2),
                          "etaMin": round((len(todo) - done) / rate / 60, 1) if rate else None,
                          "peakRssMb": round(peak_rss_mb(), 1)})
        flush()

    if shard:
        return {}
    # Assemble from the cache (also covers cards processed in earlier runs).
    kept: list[CardRef] = []
    fulls: list[np.ndarray] = []
    arts: list[np.ndarray] = []
    hashes: list[np.ndarray] = []
    for card in cards:
        feat = _load_feat(_feat_path(cache_dir, card), _feat_id(embedder), card.image_url)
        if feat is None:
            continue
        kept.append(card)
        fulls.append(feat[0])
        arts.append(feat[1])
        hashes.append(feat[2])
    if not kept:
        raise RuntimeError(f"[{language}] no cards could be indexed ({len(failures)} failures)")
    (cache_dir).mkdir(parents=True, exist_ok=True)
    (cache_dir / f"failures-{language}.json").write_text(json.dumps(failures, indent=1), "utf-8")
    elapsed = time.monotonic() - started
    manifest = write_index(
        out_dir, kept, np.stack(fulls).astype(np.float32), np.stack(arts).astype(np.float32),
        np.stack(hashes), language=language, embedder_id=embedder.identifier,
        model_name=constants.EMBED_MODEL_NAME, catalog_version=catalog_version,
        extra={
            "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "build": {
                "catalogCardsWithImage": len(cards), "indexed": len(kept), "reusedFromCache": cached,
                "processedThisRun": len(todo), "failed": len(failures),
                "elapsedSec": round(elapsed, 1), "peakRssMb": round(peak_rss_mb(), 1),
            },
        },
    )
    return manifest


def build(settings: Settings, languages: list[str], limit: int | None = None,
          shard: tuple[int, int] | None = None,
          progress: ProgressFn | None = None) -> dict[str, dict]:
    """CLI entry: ``index build --lang en,ja [--limit N]``."""
    model = ensure_model(settings)
    embedder = OnnxEmbedder(model, threads=settings.ort_threads)
    fetcher = ImageFetcher(settings.cache_dir)
    results: dict[str, dict] = {}
    try:
        for lang in languages:
            pack = find_pack(settings.catalog_dir, lang)
            cards = read_cards(pack)
            if limit:
                cards = cards[:limit]
            out = (settings.data_dir / "index-sample" / lang) if limit else settings.index_dir / lang
            results[lang] = build_language(
                cards, language=lang, settings=settings, embedder=embedder, fetcher=fetcher,
                catalog_version=pack.version, out_dir=out, progress=progress, shard=shard,
            )
    finally:
        fetcher.close()
    return results
