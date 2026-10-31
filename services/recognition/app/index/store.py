"""On-disk index: write (atomic) and load (memory-mapped float16 -> float32 working copy).

Layout per language, ``data/index/<lang>/``::

    emb_full.npy   float16 (N, 384)   L2-normalised CLS of the whole card
    emb_art.npy    float16 (N, 384)   L2-normalised CLS of the artwork crop
    hashes.npy     uint8   (N, 5, 32) packed phash/dhash/phash_r/g/b
    ids.json       ["swsh3-136", ...] row-aligned card ids
    cards.json     row-aligned catalog metadata (what the API returns)
    index-manifest.json   versions / counts / sha256 of every artifact
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from app.core import constants
from app.models import CardRef

MANIFEST_NAME = "index-manifest.json"
ARTIFACTS = ("emb_full.npy", "emb_art.npy", "hashes.npy", "ids.json", "cards.json")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_write(path: Path, writer) -> None:  # noqa: ANN001
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("wb") as handle:
        writer(handle)
    os.replace(tmp, path)


def write_index(
    out_dir: Path,
    cards: list[CardRef],
    emb_full: np.ndarray,
    emb_art: np.ndarray,
    hashes: np.ndarray,
    *,
    language: str,
    embedder_id: str,
    model_name: str,
    catalog_version: str,
    extra: dict | None = None,
) -> dict:
    """Write all artifacts and the manifest (manifest last, so a crash leaves the old index valid)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    n = len(cards)
    assert emb_full.shape == (n, constants.EMBED_DIM) and emb_art.shape == emb_full.shape
    assert hashes.shape == (n, len(constants.HASH_KINDS), constants.HASH_BITS // 8)
    _atomic_write(out_dir / "emb_full.npy", lambda h: np.save(h, emb_full.astype(np.float16)))
    _atomic_write(out_dir / "emb_art.npy", lambda h: np.save(h, emb_art.astype(np.float16)))
    _atomic_write(out_dir / "hashes.npy", lambda h: np.save(h, hashes.astype(np.uint8)))
    _atomic_write(out_dir / "ids.json", lambda h: h.write(json.dumps([c.card_id for c in cards]).encode()))
    _atomic_write(
        out_dir / "cards.json",
        lambda h: h.write(json.dumps([asdict(c) for c in cards], ensure_ascii=False).encode("utf-8")),
    )
    files = {name: {"bytes": (out_dir / name).stat().st_size, "sha256": sha256_file(out_dir / name)}
             for name in ARTIFACTS}
    version = f"{catalog_version}+{embedder_id.rsplit(':', 1)[-1]}+{files['emb_full.npy']['sha256'][:8]}"
    manifest = {
        "manifestVersion": 1,
        "language": language,
        "indexVersion": version,
        "catalogVersion": catalog_version,
        "embedder": embedder_id,
        "model": model_name,
        "embedDim": constants.EMBED_DIM,
        "dtype": "float16",
        "hashKinds": list(constants.HASH_KINDS),
        "imageQuality": f"{constants.IMAGE_QUALITY}.{constants.IMAGE_EXTENSION}",
        "counts": {"cards": n},
        "files": files,
        **(extra or {}),
    }
    _atomic_write(out_dir / MANIFEST_NAME, lambda h: h.write(json.dumps(manifest, indent=2).encode()))
    return manifest


@dataclass(slots=True)
class LoadedIndex:
    """Merged, query-ready view of one or more language indexes."""

    cards: list[CardRef]
    languages: list[str]
    lang_of_row: np.ndarray  # (N,) '<U2'
    emb_full: np.ndarray  # float32 (N, D)
    emb_art: np.ndarray
    hashes: np.ndarray
    numbers: np.ndarray  # int32, -1 = none
    official: np.ndarray  # int32, 0 = unknown
    totals: np.ndarray  # int32, 0 = unknown
    manifests: dict[str, dict]
    version: str
    embedder: str

    def __len__(self) -> int:
        return len(self.cards)


def load_index(index_dir: Path, languages: tuple[str, ...] | list[str]) -> LoadedIndex | None:
    """Load every available ``<index_dir>/<lang>`` index; ``None`` if none exist."""
    parts: list[tuple[str, dict, list[CardRef], np.ndarray, np.ndarray, np.ndarray]] = []
    for lang in languages:
        d = index_dir / lang
        manifest_path = d / MANIFEST_NAME
        if not manifest_path.is_file():
            continue
        manifest = json.loads(manifest_path.read_text("utf-8"))
        cards = [CardRef(**c) for c in json.loads((d / "cards.json").read_text("utf-8"))]
        if not cards:
            continue
        full = np.load(d / "emb_full.npy", mmap_mode="r")
        art = np.load(d / "emb_art.npy", mmap_mode="r")
        hashes = np.load(d / "hashes.npy", mmap_mode="r")
        if not (len(cards) == full.shape[0] == art.shape[0] == hashes.shape[0]):
            raise ValueError(f"index {lang}: artifact row counts disagree")
        parts.append((lang, manifest, cards, full, art, hashes))
    if not parts:
        return None
    embedders = {p[1]["embedder"] for p in parts}
    if len(embedders) != 1:
        raise ValueError(f"indexes were built with different embedders: {embedders}")
    cards = [c for p in parts for c in p[2]]
    return LoadedIndex(
        cards=cards,
        languages=[p[0] for p in parts],
        lang_of_row=np.array([c.language for c in cards]),
        emb_full=np.concatenate([np.asarray(p[3], dtype=np.float32) for p in parts]),
        emb_art=np.concatenate([np.asarray(p[4], dtype=np.float32) for p in parts]),
        hashes=np.concatenate([np.asarray(p[5]) for p in parts]),
        numbers=np.array([c.number if c.number is not None else -1 for c in cards], dtype=np.int32),
        official=np.array([c.official_count or 0 for c in cards], dtype=np.int32),
        totals=np.array([c.total_count or 0 for c in cards], dtype=np.int32),
        manifests={p[0]: p[1] for p in parts},
        version="|".join(f"{p[0]}:{p[1]['indexVersion']}" for p in parts),
        embedder=embedders.pop(),
    )
