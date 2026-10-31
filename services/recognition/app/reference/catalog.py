"""Read card metadata from the built catalog SQLite packs (docs/CATALOG-PACKS.md).

The recognition service never crawls TCGdex for metadata: ``catalog_cards`` +
``catalog_sets`` in ``catalog-<lang>-<version>.db`` are the single source.
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from app.models import CardRef

_PACK_RE = re.compile(r"^catalog-(?P<lang>[a-z]{2})-(?P<version>[\d.]+)\.db$")


@dataclass(frozen=True, slots=True)
class CatalogPack:
    language: str
    version: str
    path: Path


def find_pack(catalog_dir: Path, language: str) -> CatalogPack:
    """Newest decompressed ``catalog-<language>-<version>.db`` in ``catalog_dir``."""
    found: list[CatalogPack] = []
    for entry in catalog_dir.glob(f"catalog-{language}-*.db"):
        match = _PACK_RE.match(entry.name)
        if match:
            found.append(CatalogPack(language, match.group("version"), entry))
    if not found:
        raise FileNotFoundError(f"no catalog-{language}-*.db pack in {catalog_dir}")
    return max(found, key=lambda p: p.version)


def read_cards(pack: CatalogPack, *, only_with_image: bool = True,
               exclude_series: tuple[str, ...] = ("tcgp",)) -> list[CardRef]:
    """All physical cards (optionally only those with an ``image_url``), ordered by set then number.

    TCG Pocket (``tcgp``) is excluded: digital-only cards are not scannable (RECOGNITION-DESIGN D5).
    """
    query = (
        "SELECT c.language, c.id, c.local_id, c.name, c.set_id, s.name, c.image_url,"
        " s.official_count, s.total_count, s.release_date,"
        " c.has_reverse, c.has_first_edition, c.w_promo"
        " FROM catalog_cards c JOIN catalog_sets s ON s.language = c.language AND s.id = c.set_id"
        " WHERE COALESCE(s.series, '') NOT IN (" + ",".join("?" * len(exclude_series)) + ")"
        + (" AND c.image_url IS NOT NULL AND c.image_url <> ''" if only_with_image else "")
        + " ORDER BY c.set_id, c.local_id_sort, c.id"
    )
    con = sqlite3.connect(f"file:{pack.path.as_posix()}?mode=ro", uri=True)
    try:
        rows = con.execute(query, exclude_series).fetchall()
    finally:
        con.close()
    cards: list[CardRef] = []
    for (lang, cid, local_id, name, set_id, set_name, image_url, official, total, released,
         has_reverse, has_first, w_promo) in rows:
        year = int(released[:4]) if released and released[:4].isdigit() else None
        cards.append(
            CardRef(
                language=lang, card_id=cid, local_id=local_id, name=name, set_id=set_id,
                set_name=set_name, image_url=image_url,
                official_count=official if official else None,
                total_count=total if total else None,
                release_year=year, has_reverse=bool(has_reverse),
                has_first_edition=bool(has_first), w_promo=bool(w_promo),
            )
        )
    return cards
