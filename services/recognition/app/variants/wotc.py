# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/variants/wotc.py -- see THIRD_PARTY_NOTICES.md
"""WOTC-era variant checks: 1st Edition stamp and shadowless layout.

Both only make sense on early cards, so each is gated on the card's era (and, for
1st Edition, on the catalogue listing that variant). The checks are geometric and
rule-based — no training — reading fixed regions of the rectified card.
"""

from __future__ import annotations

import numpy as np

from app.core import constants
from app.core.constants import ERA_WOTC
from app.models import CardRef, VariantGuess, VariantKind
from app.variants import features
from app.vision import regions


def detect_first_edition(card: np.ndarray, card_ref: CardRef) -> VariantGuess | None:
    """Judge whether the 1st Edition stamp is present at the lower-left of the art.

    Args:
        card: Rectified, canonical-size card image.
        card_ref: Catalogue entry; the check applies only to WOTC-era cards that
            list a 1st Edition variant.

    Returns:
        A :class:`VariantGuess`, or ``None`` when the check does not apply.
    """
    if card_ref.era != ERA_WOTC or not card_ref.has_first_edition:
        return None
    stamp = regions.first_edition_stamp(card)
    dark = features.dark_fraction(stamp)
    edges = features.high_frequency_energy(stamp)
    present = (
        constants.FIRST_EDITION_DARK_MIN <= dark <= constants.FIRST_EDITION_DARK_MAX
        and edges >= constants.FIRST_EDITION_MIN_EDGE_ENERGY
    )
    confidence = float(np.clip(dark * 2.0, 0.0, constants.VARIANT_SINGLE_STILL_CONF_CAP))
    return VariantGuess(VariantKind.FIRST_EDITION, present=present, confidence=confidence)


def detect_shadowless(card: np.ndarray, card_ref: CardRef) -> VariantGuess | None:
    """Judge whether a WOTC card is shadowless (no drop shadow right of the art).

    Args:
        card: Rectified, canonical-size card image.
        card_ref: Catalogue entry; the check applies only to WOTC-era cards.

    Returns:
        A :class:`VariantGuess`, or ``None`` when the check does not apply.
    """
    if card_ref.era != ERA_WOTC:
        return None
    spread = features.brightness_std(regions.art_frame_right(card))
    present = spread < constants.SHADOWLESS_MAX_STD
    # Further below the shadow threshold → more confident it is shadowless.
    margin = (constants.SHADOWLESS_MAX_STD - spread) / constants.SHADOWLESS_MAX_STD
    confidence = float(np.clip(margin, 0.0, constants.VARIANT_SINGLE_STILL_CONF_CAP))
    return VariantGuess(VariantKind.SHADOWLESS, present=present, confidence=confidence)
