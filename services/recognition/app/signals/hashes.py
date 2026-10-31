# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/signals/hashes.py -- see THIRD_PARTY_NOTICES.md
"""Perceptual-hash signal: 5 kinds x 256 bits (phash, dhash, per-channel phash).

Same hash family as pokeum (DCT ``phash``, gradient ``dhash``, one ``phash`` per RGB
channel, 16x16 = 256 bits) but computed with OpenCV instead of ``imagehash``/PIL/scipy:
~20x faster (the imagehash version cost ~110 ms/card, a third of the index build).
Bits are packed to ``(5, 32)`` uint8; matching is XOR + popcount (NumPy >= 2.0
``bitwise_count``) over an ``(N, 5, 32)`` array, keyed by row number.
Hashes are self-consistent between index and query (same function), not bit-compatible
with imagehash (hence ``constants.HASH_VERSION`` in the feature-cache key).
"""

from __future__ import annotations

import cv2
import numpy as np

from app.core import constants

HASH_KINDS = constants.HASH_KINDS
HASH_BYTES = constants.HASH_BITS // 8
_SIZE = constants.HASH_SIZE
_DCT_SIDE = _SIZE * 4  # pokeum/imagehash highfreq_factor = 4


def _phash_bits(channel: np.ndarray) -> np.ndarray:
    small = cv2.resize(channel, (_DCT_SIDE, _DCT_SIDE), interpolation=cv2.INTER_AREA)
    dct = cv2.dct(small.astype(np.float32))
    low = dct[:_SIZE, :_SIZE]
    return (low > np.median(low)).ravel()


def _dhash_bits(gray: np.ndarray) -> np.ndarray:
    small = cv2.resize(gray, (_SIZE + 1, _SIZE), interpolation=cv2.INTER_AREA).astype(np.int16)
    return (small[:, 1:] > small[:, :-1]).ravel()


def compute_hashes(image: np.ndarray) -> np.ndarray:
    """Return a ``(5, 32)`` uint8 array of packed hashes in :data:`HASH_KINDS` order."""
    rgb = np.ascontiguousarray(image, dtype=np.uint8)
    # One cheap pre-shrink keeps every per-channel resize tiny regardless of source size.
    height, width = rgb.shape[:2]
    if max(height, width) > 256:
        scale = 256.0 / max(height, width)
        rgb = cv2.resize(rgb, (max(_SIZE + 1, round(width * scale)), max(_SIZE + 1, round(height * scale))),
                         interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    rows = [_phash_bits(gray), _dhash_bits(gray)]
    rows.extend(_phash_bits(np.ascontiguousarray(rgb[:, :, c])) for c in range(3))
    return np.stack([np.packbits(r.astype(np.uint8)) for r in rows]).astype(np.uint8)


def hash_similarity(matrix: np.ndarray, query: np.ndarray) -> np.ndarray:
    """Raw similarity in [0, 1] of ``query`` (5, 32) against ``matrix`` (N, 5, 32).

    Per card: minimum Hamming distance across kinds, mapped to ``1 - d / 256``.
    """
    if matrix.size == 0:
        return np.zeros(0, dtype=np.float32)
    dist = np.bitwise_count(np.bitwise_xor(matrix, query[None, :, :])).sum(axis=2, dtype=np.int32)
    best = dist.min(axis=1)
    return 1.0 - best.astype(np.float32) / float(constants.HASH_BITS)
