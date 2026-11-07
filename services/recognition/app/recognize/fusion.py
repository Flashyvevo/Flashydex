# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/recognize/fusion.py -- see THIRD_PARTY_NOTICES.md
"""Fuse per-signal scores into ranked candidates and a decision.

Pure NumPy. Differences from pokeum: scores are computed for *every* indexed row
(a 23k x 384 matmul is milliseconds), so there is no shortlist that can drop the card
OCR points at; raw cosine / hash similarity are floor-rescaled (see constants);
OCR boosts/penalises per candidate but is never a hard gate; a language mask replaces
language factors (the API hint filters rows).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

import numpy as np

from app.core import constants
from app.models import OcrObservation

SIGNAL_WEIGHTS: dict[str, float] = {
    "emb_full": constants.WEIGHT_EMBED_FULL,
    "emb_art": constants.WEIGHT_EMBED_ART,
    "hash": constants.WEIGHT_HASH,
    "symbol": constants.WEIGHT_SYMBOL,
}


class Status(StrEnum):
    MATCH = "match"
    CANDIDATES = "candidates"
    NO_CARD = "no_card"
    NO_MATCH = "no_match"


def rescale(values: np.ndarray, floor: float) -> np.ndarray:
    """Map ``[floor, 1]`` onto ``[0, 1]`` (clipped)."""
    return np.clip((values - floor) / (1.0 - floor), 0.0, 1.0).astype(np.float32)


@dataclass(slots=True)
class OcrAgreement:
    factor: np.ndarray  # (N,) multiplicative nudge
    score: np.ndarray  # (N,) 1.0 number+total agree, 0.5 number only, 0.0 otherwise


def ocr_agreement(ocr: OcrObservation | None, numbers: np.ndarray, official: np.ndarray,
                  totals: np.ndarray) -> OcrAgreement | None:
    """Per-row OCR consistency. ``None`` when OCR carries no usable number."""
    if ocr is None or not ocr.is_useful or ocr.confidence < constants.OCR_MIN_CONFIDENCE:
        return None  # nothing (trustworthy) read -> neutral: no boost, no penalty, no 0.0 signal
    number_ok = numbers == ocr.number
    if ocr.number_total:
        total_ok = (official == ocr.number_total) | (totals == ocr.number_total) | (
            (official == 0) & (totals == 0)
        )
    else:
        total_ok = np.ones_like(number_ok)
    full = number_ok & total_ok
    score = np.where(full, 1.0, np.where(number_ok, 0.5, 0.0)).astype(np.float32)
    factor = np.where(
        full, 1.0 + constants.OCR_BOOST * ocr.confidence,
        np.where(number_ok, 1.0, 1.0 - constants.OCR_PENALTY * ocr.confidence),
    ).astype(np.float32)
    return OcrAgreement(factor=factor, score=score)


def fuse_raw(signals: dict[str, np.ndarray], ocr: OcrAgreement | None) -> np.ndarray:
    """Weighted mean over the present signals, times the OCR factor. Shape ``(N,)``.

    With ``HASH_BOOST_ONLY`` the perceptual hash can only *raise* a card's score above its
    embedding-only score: a photo that is not pixel-aligned with the reference (every real photo)
    scores ~0 on the hash even for the right card, which must not drag it down.
    """
    present = [name for name in signals if name in SIGNAL_WEIGHTS]
    denom = sum(SIGNAL_WEIGHTS[n] for n in present)
    if not present or denom <= 0:
        raise ValueError("no signals to fuse")
    raw = sum(SIGNAL_WEIGHTS[n] * signals[n] for n in present) / denom
    if constants.HASH_BOOST_ONLY and "hash" in present and len(present) > 1:
        others = [n for n in present if n != "hash"]
        embed_only = sum(SIGNAL_WEIGHTS[n] * signals[n] for n in others) / sum(SIGNAL_WEIGHTS[n] for n in others)
        raw = np.maximum(raw, embed_only)
    if ocr is not None:
        raw = raw * ocr.factor
    return np.asarray(raw, dtype=np.float32)


def rank(raw: np.ndarray, mask: np.ndarray | None, top_k: int) -> tuple[np.ndarray, np.ndarray]:
    """Top-k row indices (best first) among ``mask`` and their confidences (pokeum normalisation).

    ``confidence_i = raw_i / raw_top * min(raw_top, 1)``: absolute quality for the top card,
    relative standing for runners-up (which is what the margin rule needs).
    """
    scores = raw if mask is None else np.where(mask, raw, -np.inf)
    k = min(top_k, int(np.isfinite(scores).sum()))
    if k <= 0:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.float32)
    part = np.argpartition(-scores, k - 1)[:k]
    order = part[np.argsort(-scores[part])]
    top_raw = float(scores[order[0]])
    if top_raw <= 0:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.float32)
    quality = min(top_raw, 1.0)
    conf = np.clip(scores[order] / top_raw * quality, 0.0, 1.0).astype(np.float32)
    return order.astype(np.int64), conf


def decide(conf: np.ndarray) -> Status:
    """``match`` only above the high threshold with a clear margin; else candidates / no_match."""
    if conf.size == 0:
        return Status.NO_MATCH
    top = float(conf[0])
    runner = float(conf[1]) if conf.size > 1 else 0.0
    if top >= constants.CONFIDENT_THRESHOLD and (top - runner) >= constants.CONFIDENT_MARGIN:
        return Status.MATCH
    if top >= constants.UNCERTAIN_THRESHOLD:
        return Status.CANDIDATES
    return Status.NO_MATCH
