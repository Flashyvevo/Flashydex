# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/variants/reverse_holo.py -- see THIRD_PARTY_NOTICES.md
"""Reverse-holo detection.

A reverse-holo card foils the whole body *except* the artwork, so the text and
border area sparkles. TCGdex ships a single flat image per card, so detection is
intrinsic rather than comparative: measure high-frequency energy in the card body
and, when the catalogue says a reverse variant exists, judge whether the foil is
present. A single still is weak evidence, so confidence is capped — the webcam
path, aggregating specular changes across frames, is far stronger.
"""

from __future__ import annotations

import numpy as np

from app.core import constants
from app.models import CardRef, VariantGuess, VariantKind
from app.variants import features
from app.vision import regions


def detect_reverse_holo(card: np.ndarray, card_ref: CardRef) -> VariantGuess | None:
    """Judge whether a card shows reverse-holo foil in its body.

    Args:
        card: Rectified, canonical-size card image.
        card_ref: Catalogue entry, used to gate on a known reverse variant.

    Returns:
        A :class:`VariantGuess`, or ``None`` when the card has no reverse variant
        and the check does not apply.
    """
    if not card_ref.has_reverse:
        return None
    energy = features.high_frequency_energy(regions.reverse_holo_body(card))
    present = energy >= constants.REVERSE_HOLO_MIN_ENERGY
    confidence = min(
        energy / constants.REVERSE_HOLO_ENERGY_SCALE,
        constants.VARIANT_SINGLE_STILL_CONF_CAP,
    )
    confidence = float(np.clip(confidence, 0.0, constants.VARIANT_SINGLE_STILL_CONF_CAP))
    return VariantGuess(VariantKind.REVERSE_HOLO, present=present, confidence=confidence)
