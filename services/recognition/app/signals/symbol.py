"""Set-symbol signal -- STUB.

TODO(phase 2b): port pokeum's ZNCC SymbolMatcher (app/signals/symbol.py) keyed by
``(language, setId)``. TCGdex symbol URLs need ``univ`` -> ``en`` + ``.webp``
(RECOGNITION-DESIGN §3). Coverage is EN-only in practice (JA: neo1-4), and the
signal carries 10 % weight only when no validated set code exists, so the service
ships without it; fusion renormalises over the signals that are present and the API
reports ``signals.symbol = null``.
"""

from __future__ import annotations

import numpy as np


class SymbolMatcher:
    """No-op matcher: returns no scores."""

    def __len__(self) -> int:
        return 0

    def match(self, card: np.ndarray) -> dict[str, float]:  # noqa: ARG002
        return {}
