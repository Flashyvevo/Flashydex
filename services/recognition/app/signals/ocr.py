# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/signals/ocr.py -- see THIRD_PARTY_NOTICES.md
"""OCR signal: read and interpret the card's bottom strip.

Parsing is pure (``parse_collector_number``, ``parse_set_code``, ``interpret_lines``);
:class:`RapidOcrEngine` wraps ``rapidocr_onnxruntime`` (models bundled in the wheel,
so the service works offline). Differences from pokeum: ``number`` is an ``int``;
promo forms ``001/SV-P`` (no numeric total) are accepted; stopwords ``JP``/``JA``;
the 1.x RapidOCR API (``(result, elapse)`` tuples, argparse-style kwargs).
OCR is never a hard gate: fusion only uses it as a multiplicative nudge.
"""

from __future__ import annotations

import logging
import re
import threading

import numpy as np

from app.core import constants
from app.models import OcrObservation
from app.vision import regions

logger = logging.getLogger(__name__)

_DIGIT_LOOKALIKES = str.maketrans({"O": "0", "o": "0", "I": "1", "l": "1", "|": "1"})
_NUMBER_RE = re.compile(r"(\d{1,4})\s*/\s*(\d{1,4})")
_PROMO_RE = re.compile(r"(\d{1,3})\s*/\s*([A-Z]{1,4}-?P)\b")
_SET_CODE_RE = re.compile(r"\b([A-Z]{2,4})\b")
_SET_CODE_STOPWORDS = frozenset(
    {"EN", "HP", "LV", "NO", "GX", "EX", "GG", "TG", "JP", "JA", "SP"}
)


def parse_collector_number(text: str) -> tuple[int | None, int | None]:
    """Parse ``number/total`` from OCR text -> ``(number, total)``; either may be ``None``.

    Digit look-alikes are repaired (``O25 / 193`` -> ``(25, 193)``). Promo forms such as
    ``001/SV-P`` yield ``(1, None)``.
    """
    promo = _PROMO_RE.search(text)
    if promo:
        return int(promo.group(1).translate(_DIGIT_LOOKALIKES)), None
    match = _NUMBER_RE.search(text.translate(_DIGIT_LOOKALIKES))
    if not match:
        return None, None
    return int(match.group(1)), int(match.group(2))


def parse_set_code(text: str) -> str | None:
    """First plausible 2-4 letter uppercase set code, or promo code like ``SV-P``."""
    promo = re.search(r"/\s*([A-Z]{1,4}-?P)\b", text)
    if promo:
        return promo.group(1)
    for candidate in _SET_CODE_RE.findall(text):
        if candidate not in _SET_CODE_STOPWORDS:
            return candidate
    return None


def interpret_lines(lines: list[tuple[str, float]]) -> OcrObservation:
    """Combine OCR lines into one observation (best-confidence line with a number wins)."""
    raw = " ".join(text for text, _ in lines).strip()
    best_number: int | None = None
    best_total: int | None = None
    best_conf = 0.0
    for text, conf in sorted(lines, key=lambda item: item[1], reverse=True):
        number, total = parse_collector_number(text)
        if number is not None:
            best_number, best_total, best_conf = number, total, conf
            break
    if best_number is None:
        best_number, best_total = parse_collector_number(raw)
        best_conf = max((c for _, c in lines), default=0.0)
    return OcrObservation(
        raw_text=raw,
        number=best_number,
        number_total=best_total,
        set_code=parse_set_code(raw),
        confidence=float(best_conf),
    )


class RapidOcrEngine:
    """RapidOCR (PP-OCR via ONNX Runtime), serialised behind a lock."""

    def __init__(self) -> None:
        from rapidocr_onnxruntime import RapidOCR

        self._reader = RapidOCR(
            det_limit_side_len=constants.OCR_DETECT_MAX_SIDE,
            det_limit_type="max",
            intra_op_num_threads=constants.OCR_INTRA_OP_THREADS,
            inter_op_num_threads=constants.OCR_INTER_OP_THREADS,
            min_height=10,
        )
        self._lock = threading.Lock()

    def read_text(self, image: np.ndarray) -> list[tuple[str, float]]:
        with self._lock:
            result, _elapse = self._reader(np.asarray(image), use_det=True, use_cls=False, use_rec=True)
        if not result:
            return []
        return [(str(item[1]), float(item[2])) for item in result]


def read_card(engine: RapidOcrEngine, card: np.ndarray) -> OcrObservation:
    """OCR a rectified card's bottom strip."""
    lines = engine.read_text(regions.bottom_strip(card))
    logger.debug("ocr lines: %d", len(lines))
    return interpret_lines(lines)
