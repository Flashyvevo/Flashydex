"""End-to-end: tiny real index (30 cards from the EN catalog pack, images from TCGdex) + identify.

Needs network (TCGdex images), the decompressed catalog pack and the DINOv2 model; skipped otherwise.
Per-stage timings are printed (``pytest -s``) and written to ``data/logs/e2e-timings.json``.
"""

from __future__ import annotations

import json
import statistics

import cv2
import numpy as np
import pytest

from app.core import constants
from app.core.config import Settings
from app.index.build import build_language
from app.index.store import load_index
from app.recognize.pipeline import Recognizer
from app.reference.catalog import find_pack, read_cards
from app.reference.images import ImageFetcher, image_path
from app.signals.embedding import OnnxEmbedder
from app.signals.ocr import RapidOcrEngine
from app.synth import add_glare, jpeg_bytes, on_table

N_CARDS = 30


@pytest.fixture(scope="module")
def world(tmp_path_factory):
    live = Settings.from_env()
    model = live.models_dir / constants.EMBED_MODEL_FILE
    if not model.is_file():
        pytest.skip("embedding model not downloaded (run `index build` / `model fetch` once)")
    try:
        pack = find_pack(live.catalog_dir, "en")
    except FileNotFoundError:
        pytest.skip("decompressed EN catalog pack not available")
    cards = read_cards(pack)
    step = max(1, len(cards) // N_CARDS)
    chosen = cards[::step][:N_CARDS]

    tmp = tmp_path_factory.mktemp("e2e")
    settings = Settings(data_dir=tmp, catalog_dir=live.catalog_dir)
    fetcher = ImageFetcher(settings.cache_dir)
    try:
        fetcher.ensure(chosen[0])
    except Exception as error:  # noqa: BLE001
        pytest.skip(f"offline / TCGdex unreachable: {error}")
    embedder = OnnxEmbedder(model)
    manifest = build_language(chosen, language="en", settings=settings, embedder=embedder, fetcher=fetcher,
                              catalog_version=pack.version)
    index = load_index(settings.index_dir, ("en",))
    assert index is not None and len(index) == manifest["counts"]["cards"]
    assert len(index) >= N_CARDS - 2  # a card or two may 404; the rest must be indexed
    recognizer = Recognizer(index, embedder, RapidOcrEngine())
    refs = {c.card_id: image_path(settings.cache_dir, c) for c in chosen if (image_path(settings.cache_dir, c)).exists()}
    return recognizer, index, refs


TIMINGS: list[dict] = []


def _record(label: str, result: dict) -> None:
    TIMINGS.append({"case": label, **result["timingMs"]})
    print(f"\n[{label}] status={result['status']} conf={result['confidence']} "
          f"top={[(c['cardId'], c['score']) for c in result['candidates']]} timing={result['timingMs']}")


def test_manifest_and_index_files(world):
    _, index, _ = world
    m = index.manifests["en"]
    assert m["embedder"].startswith("onnx:dinov2-small:") and m["dtype"] == "float16"
    assert set(m["files"]) == {"emb_full.npy", "emb_art.npy", "hashes.npy", "ids.json", "cards.json"}
    assert index.emb_full.shape[1] == constants.EMBED_DIM


def test_exact_reference_image_is_a_match(world):
    recognizer, index, refs = world
    wrong = []
    for card_id, path in list(refs.items())[:10]:
        res = recognizer.identify_bytes(path.read_bytes(), lang="en")
        _record(f"exact:{card_id}", res)
        if not (res["status"] == "match" and res["candidates"][0]["cardId"] == card_id):
            wrong.append((card_id, res["status"], [c["cardId"] for c in res["candidates"]]))
    assert not wrong, wrong


def test_degraded_photo_top3_contains_card(world):
    recognizer, _, refs = world
    misses = []
    for k, (card_id, path) in enumerate(list(refs.items())[:12]):
        ref = cv2.cvtColor(cv2.imread(str(path)), cv2.COLOR_BGR2RGB)
        ref = cv2.resize(ref, (constants.CARD_WIDTH_PX, constants.CARD_HEIGHT_PX), interpolation=cv2.INTER_CUBIC)
        photo = add_glare(on_table(ref, angle=8, scale=0.55 + 0.02 * (k % 4), seed=k), 0.35)
        res = recognizer.identify_bytes(jpeg_bytes(photo, 60), lang="en", max_candidates=3)
        _record(f"photo:{card_id}", res)
        if card_id not in [c["cardId"] for c in res["candidates"]]:
            misses.append((card_id, res["status"], [c["cardId"] for c in res["candidates"]]))
    assert not misses, misses


def test_blank_gray_is_no_card_or_no_match(world):
    recognizer, _, _ = world
    gray = np.full((900, 700, 3), 128, np.uint8)
    res = recognizer.identify_bytes(jpeg_bytes(gray, 90))
    _record("blank-gray", res)
    assert res["status"] in ("no_card", "no_match") and res["candidates"] == []


def test_unrelated_busy_scene_never_matches(world):
    recognizer, _, _ = world
    rng = np.random.default_rng(5)
    noise = cv2.GaussianBlur(rng.integers(0, 255, (900, 700, 3), dtype=np.uint8), (0, 0), 5)
    res = recognizer.identify_bytes(jpeg_bytes(noise, 85))
    _record("noise", res)
    assert res["status"] != "match"


def test_language_hint_filters(world):
    recognizer, _, refs = world
    path = next(iter(refs.values()))
    res = recognizer.identify_bytes(path.read_bytes(), lang="ja")
    assert res["status"] in ("no_match", "no_card") and res["candidates"] == []


def test_zz_print_timing_summary(world):
    assert TIMINGS
    stages = sorted({k for t in TIMINGS for k in t if k != "case"})
    summary = {s: {"p50": round(statistics.median([t[s] for t in TIMINGS if s in t]), 1),
                   "max": round(max(t[s] for t in TIMINGS if s in t), 1)} for s in stages}
    print("\nPER-STAGE TIMINGS (ms) over", len(TIMINGS), "identify calls:\n", json.dumps(summary, indent=1))
    out = Settings.from_env().data_dir / "logs"
    out.mkdir(parents=True, exist_ok=True)
    (out / "e2e-timings.json").write_text(json.dumps({"summary": summary, "calls": TIMINGS}, indent=1), "utf-8")
