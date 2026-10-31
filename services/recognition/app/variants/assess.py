# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/variants/assess.py -- see THIRD_PARTY_NOTICES.md
"""Run every applicable variant check on the winning card.

Each detector self-gates (on era or catalogue variant flags) and returns ``None``
when it does not apply, so this aggregator simply runs them and keeps the guesses
that fired. Only the recognized card is assessed — variant checks are too
expensive and too card-specific to run on every candidate.
"""

from __future__ import annotations

import numpy as np

from app.models import CardRef, VariantGuess
from app.variants.reverse_holo import detect_reverse_holo
from app.variants.stamps import detect_promo_stamp
from app.variants.wotc import detect_first_edition, detect_shadowless


def assess_variants(card: np.ndarray, card_ref: CardRef) -> tuple[VariantGuess, ...]:
    """Return the variant guesses that apply to a recognized card.

    Args:
        card: Rectified, canonical-size card image.
        card_ref: The recognized catalogue entry.

    Returns:
        A tuple of :class:`VariantGuess` for every check that applied.
    """
    guesses = [
        detect_reverse_holo(card, card_ref),
        detect_first_edition(card, card_ref),
        detect_shadowless(card, card_ref),
        detect_promo_stamp(card, card_ref),
    ]
    return tuple(guess for guess in guesses if guess is not None)
