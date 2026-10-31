# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/variants/stamps.py -- see THIRD_PARTY_NOTICES.md
"""Promo-stamp detection.

Promotional cards carry a stamp (often a gold/black foil badge) in the lower-left
of the artwork. Detection looks for a compact, high-saturation-or-dark mark that
stands out from the surrounding art. Because stamps vary widely, the threshold is
deliberately high: assert a stamp only on strong evidence, to avoid false
positives on busy artwork.
"""

from __future__ import annotations

import numpy as np

from app.core import constants
from app.models import CardRef, VariantGuess, VariantKind
from app.variants import features
from app.vision import regions


def detect_promo_stamp(card: np.ndarray, card_ref: CardRef) -> VariantGuess | None:
    """Judge whether a promo stamp is present in the lower-left artwork.

    Args:
        card: Rectified, canonical-size card image.
        card_ref: Catalogue entry (reserved for future gating on set/rarity).

    Returns:
        A :class:`VariantGuess`; ``present`` is only ``True`` on strong evidence.
    """
    # RECOGNITION-DESIGN §5: gated on the catalogue wPromo flag (Pokeum left it ungated,
    # which false-positives on busy artwork).
    if not card_ref.w_promo:
        return None
    region = regions.promo_stamp(card)
    saturation = features.mean_saturation(region)
    darkness = features.dark_fraction(region, threshold=0.25)
    score = max(saturation, darkness)
    present = score >= constants.PROMO_STAMP_MIN_SCORE
    confidence = float(np.clip(score, 0.0, constants.VARIANT_SINGLE_STILL_CONF_CAP))
    return VariantGuess(VariantKind.PROMO_STAMP, present=present, confidence=confidence)
