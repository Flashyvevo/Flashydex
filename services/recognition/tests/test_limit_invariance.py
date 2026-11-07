"""S10-02: the match/margin decision must not depend on the response limit (``max_candidates``).

Uses the LIVE index + model (skipped when unavailable) and Sol's two reproductions: the top 78 % of a
reference image, stretched back to 630x880, must never be a ``match`` for the wrong printing.
"""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from app.core.config import Settings
from app.recognize import fusion
from app.recognize.pipeline import Recognizer

LIMITS = (1, 2, 3, 5)


def _cached(settings: Settings, card_id: str):
    path = settings.cache_dir / "images" / "en" / f"{card_id}.webp"
    if not path.is_file():
        pytest.skip(f"cached reference {card_id} not available")
    return path


def top_crop_jpeg(path, fraction: float = 0.78) -> bytes:
    img = Image.open(path).convert("RGB")
    w, h = img.size
    crop = img.crop((0, 0, w, int(h * fraction))).resize((630, 880), Image.Resampling.BILINEAR)
    out = io.BytesIO()
    crop.save(out, "JPEG", quality=85)
    return out.getvalue()


@pytest.fixture(scope="module")
def live():
    settings = Settings.from_env()
    try:
        rec = Recognizer.from_settings(settings)
    except Exception as error:  # noqa: BLE001 - no model / index on this machine
        pytest.skip(f"live recognizer unavailable: {error}")
    return settings, rec


@pytest.mark.parametrize(("source", "forbidden"), [("base4-46", "base1-32"), ("lc-49", "base4-46")])
def test_cropped_reprints_are_never_a_wrong_match_at_any_limit(live, source, forbidden):
    settings, rec = live
    data = top_crop_jpeg(_cached(settings, source))
    results = {n: rec.identify_bytes(data, lang="en", max_candidates=n) for n in LIMITS}
    verdicts = {(r["status"], r["confidence"]) for r in results.values()}
    assert len(verdicts) == 1, {n: (r["status"], r["confidence"]) for n, r in results.items()}
    for n, r in results.items():
        assert len(r["candidates"]) <= n
        if r["status"] == "match":
            assert r["candidates"][0]["cardId"] != forbidden, (n, r["candidates"][0]["cardId"])
    assert results[1]["status"] != "match" or results[1]["candidates"][0]["cardId"] == source


def test_exact_reference_status_is_limit_independent(live):
    settings, rec = live
    data = _cached(settings, "swsh3-136").read_bytes()
    seen = {(r["status"], r["confidence"]) for r in
            (rec.identify_bytes(data, lang="en", max_candidates=n) for n in LIMITS)}
    assert len(seen) == 1, seen


def test_rank_for_decision_sees_runner_up_even_when_limit_is_one():
    raw = np.array([0.93, 0.92, 0.1], dtype=np.float32)
    order, conf = fusion.rank(raw, None, max(1, fusion.DECISION_ROWS))
    assert fusion.decide(conf) is fusion.Status.CANDIDATES  # tiny margin: ambiguous
    # the old behaviour (limit=1) hid the runner-up and returned a match
    assert fusion.decide(fusion.rank(raw, None, 1)[1]) is fusion.Status.MATCH
