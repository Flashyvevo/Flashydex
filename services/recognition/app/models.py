"""Plain data types shared across the service."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


@dataclass(frozen=True, slots=True)
class CardRef:
    """Catalog metadata for one indexed card (composite identity: language + card_id)."""

    language: str
    card_id: str
    local_id: str
    name: str
    set_id: str
    set_name: str
    image_url: str | None
    official_count: int | None
    total_count: int | None
    release_year: int | None
    has_reverse: bool
    has_first_edition: bool
    w_promo: bool

    @property
    def number(self) -> int | None:
        """Collector number as an int (digits of ``local_id``), if any."""
        digits = "".join(ch for ch in self.local_id if ch.isdigit())
        return int(digits) if digits else None

    @property
    def era(self) -> str:
        from app.core.constants import ERA_MODERN, ERA_WOTC, WOTC_ERA_UNTIL_YEAR

        if self.release_year is not None and self.release_year <= WOTC_ERA_UNTIL_YEAR:
            return ERA_WOTC
        return ERA_MODERN


@dataclass(frozen=True, slots=True)
class OcrObservation:
    raw_text: str = ""
    number: int | None = None
    number_total: int | None = None
    set_code: str | None = None
    confidence: float = 0.0

    @property
    def is_useful(self) -> bool:
        return self.number is not None


class VariantKind(StrEnum):
    REVERSE_HOLO = "reverse_holo"
    FIRST_EDITION = "first_edition"
    SHADOWLESS = "shadowless"
    PROMO_STAMP = "promo_stamp"


@dataclass(frozen=True, slots=True)
class VariantGuess:
    kind: VariantKind
    present: bool
    confidence: float


@dataclass(slots=True)
class Timings:
    ms: dict[str, float] = field(default_factory=dict)
