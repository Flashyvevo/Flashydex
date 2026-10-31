"""Per-card feature extraction shared by the index build and the query path.

Reference images and query photos go through the *same* function once rectified to the
canonical 630x880 card, so hash/embedding differences reflect the photo, not the pipeline.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.signals.embedding import OnnxEmbedder
from app.signals.hashes import compute_hashes
from app.vision import regions


@dataclass(slots=True)
class CardTensors:
    """Pre-embedding data for one canonical card."""

    hashes: np.ndarray  # (5, 32) uint8
    full: np.ndarray  # (3, 224, 224) float32
    art: np.ndarray  # (3, 224, 224) float32


def prepare_card(card_rgb: np.ndarray) -> CardTensors:
    return CardTensors(
        hashes=compute_hashes(card_rgb),
        full=OnnxEmbedder.preprocess(card_rgb),
        art=OnnxEmbedder.preprocess(regions.artwork(card_rgb)),
    )


def embed_prepared(embedder: OnnxEmbedder, items: list[CardTensors]) -> tuple[np.ndarray, np.ndarray]:
    """One ORT run over ``2 * len(items)`` tensors -> (full (N,D), art (N,D)) float32."""
    n = len(items)
    batch = np.stack([t.full for t in items] + [t.art for t in items])
    emb = embedder.embed_tensors(batch)
    return emb[:n], emb[n:]
