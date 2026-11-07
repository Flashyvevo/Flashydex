"""``index verify``: every indexed card id must exist in the production catalog packs (index ⊆ catalog).

Reads the plain ``catalog-<lang>-<version>.db`` SQLite files read-only (no decompression, no writes).
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from app.core.config import Settings
from app.reference.catalog import CatalogPack, read_cards


def _pack_for(path: Path) -> tuple[CatalogPack, int, int, set[str]]:
    con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        language, version = con.execute("SELECT language, version FROM catalog_meta").fetchone()
        total = con.execute("SELECT COUNT(*) FROM catalog_cards").fetchone()[0]
        with_image = con.execute(
            "SELECT COUNT(*) FROM catalog_cards WHERE image_url IS NOT NULL AND image_url <> ''").fetchone()[0]
        all_ids = {r[0] for r in con.execute("SELECT id FROM catalog_cards")}
    finally:
        con.close()
    return CatalogPack(language, version, path), total, with_image, all_ids


def verify(settings: Settings, catalog_dbs: list[Path]) -> dict:
    """Compare ``data/index/<lang>/ids.json`` against each catalog DB; return the report dict."""
    report: dict = {"languages": {}, "ok": True}
    for path in catalog_dbs:
        pack, total, with_image, all_ids = _pack_for(path)
        lang = pack.language
        ids_file = settings.index_dir / lang / "ids.json"
        indexed = json.loads(ids_file.read_text("utf-8")) if ids_file.is_file() else []
        indexed_set = set(indexed)
        orphans = sorted(indexed_set - all_ids)
        scannable = {c.card_id for c in read_cards(pack)}  # image present, tcgp excluded (index rules)
        with_image_ids = {c.card_id for c in read_cards(pack, exclude_series=())}
        missing = sorted(scannable - indexed_set)
        manifest_path = settings.index_dir / lang / "index-manifest.json"
        index_catalog = (json.loads(manifest_path.read_text("utf-8")).get("catalogVersion")
                         if manifest_path.is_file() else None)
        report["languages"][lang] = {
            "catalogDb": path.name, "catalogVersion": pack.version, "indexCatalogVersion": index_catalog,
            "catalogCards": total, "catalogCardsWithImage": with_image,
            "indexed": len(indexed), "indexedUnique": len(indexed_set),
            "orphans": len(orphans), "orphanIds": orphans[:50],
            "scannableCardsNotIndexed": len(missing), "scannableNotIndexedIds": missing[:50],
            "withImageIncludingTcgp": len(with_image_ids),
            "withImageNotIndexed": len(with_image_ids - indexed_set),
            "withImageNotIndexedExcludingTcgp": len(missing),
        }
        if orphans or len(indexed) != len(indexed_set):
            report["ok"] = False
    return report
