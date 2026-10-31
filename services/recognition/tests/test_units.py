"""Unit tests: vision, hashes, OCR parsing/engine, fusion, variants, embedding output selection."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from app.core import constants
from app.models import CardRef, OcrObservation, VariantKind
from app.recognize import fusion
from app.signals import embedding, hashes, ocr
from app.variants.assess import assess_variants
from app.vision import detect, geometry, rectify, regions
from app.synth import add_glare, make_card, on_table


# ---------------------------------------------------------------- vision
def test_order_corners_and_aspect():
    quad = geometry.order_corners(np.array([[200, 300], [10, 10], [190, 12], [8, 310]], np.float32))
    assert quad[0].tolist() == [10, 10] and quad[2].tolist() == [200, 300]
    assert geometry.aspect_ratio(quad) == pytest.approx(0.62, abs=0.05)


@pytest.mark.parametrize("angle", [0, 8, -12])
def test_detect_and_rectify_card_on_table(angle):
    card = make_card(3)
    photo = on_table(card, angle=angle, scale=0.7)
    quad = detect.detect_card_quad(photo)
    assert quad is not None
    rect = rectify.rectify(photo, quad)
    assert rect.shape == (constants.CARD_HEIGHT_PX, constants.CARD_WIDTH_PX, 3)
    # rectified art window correlates with the source art window
    a = cv2.resize(regions.artwork(rect), (64, 48)).astype(np.float32).ravel()
    b = cv2.resize(regions.artwork(card), (64, 48)).astype(np.float32).ravel()
    assert np.corrcoef(a, b)[0, 1] > 0.9


def test_blank_image_is_blank_and_has_no_quad():
    gray = np.full((900, 700, 3), 128, np.uint8)
    assert detect.detect_card_quad(gray) is None
    assert detect.looks_blank(gray)
    assert not detect.looks_blank(on_table(make_card(1)))


def test_center_crop_canonical_size():
    out = rectify.center_crop_to_card(np.random.default_rng(0).integers(0, 255, (500, 900, 3), dtype=np.uint8))
    assert out.shape == (constants.CARD_HEIGHT_PX, constants.CARD_WIDTH_PX, 3)


# ---------------------------------------------------------------- hashes
def test_hash_shape_and_self_similarity():
    h = hashes.compute_hashes(make_card(1))
    assert h.shape == (5, 32) and h.dtype == np.uint8
    matrix = np.stack([hashes.compute_hashes(make_card(s)) for s in (1, 2, 3)])
    sims = hashes.hash_similarity(matrix, h)
    assert sims[0] == 1.0 and sims[1] < 0.9 and sims[2] < 0.9


def test_hash_robust_to_glare_and_blur():
    base = make_card(7)
    others = np.stack([hashes.compute_hashes(make_card(s)) for s in range(7, 20)])
    degraded = cv2.GaussianBlur(add_glare(base, 0.3), (0, 0), 2)
    sims = hashes.hash_similarity(others, hashes.compute_hashes(degraded))
    assert int(np.argmax(sims)) == 0


# ---------------------------------------------------------------- OCR parsing
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("025/193", (25, 193)),
        ("O25 / 193", (25, 193)),
        ("SVI EN 136/189", (136, 189)),
        ("001/073", (1, 73)),  # JA modern
        ("001/SV-P", (1, None)),  # JA promo
        ("12/P", (None, None)),
        ("no digits", (None, None)),
    ],
)
def test_parse_collector_number(text, expected):
    assert ocr.parse_collector_number(text) == expected


def test_parse_set_code():
    assert ocr.parse_set_code("PAL EN 025/193") == "PAL"
    assert ocr.parse_set_code("EN JP HP") is None
    assert ocr.parse_set_code("001/SV-P") == "SV-P"


def test_interpret_lines_prefers_confident_number_line():
    obs = ocr.interpret_lines([("Illus. Mitsuhiro", 0.9), ("PAL 025/193", 0.8), ("026/100", 0.4)])
    assert (obs.number, obs.number_total, obs.set_code) == (25, 193, "PAL")
    assert obs.confidence == pytest.approx(0.8)


def test_ocr_engine_reads_collector_strip():
    pytest.importorskip("rapidocr_onnxruntime")
    card = np.full((constants.CARD_HEIGHT_PX, constants.CARD_WIDTH_PX, 3), 245, np.uint8)
    cv2.putText(card, "SVI EN 025/193", (330, 855), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)
    obs = ocr.read_card(ocr.RapidOcrEngine(), card)
    assert (obs.number, obs.number_total) == (25, 193)


# ---------------------------------------------------------------- fusion
def _ocr(number=25, total=193, conf=0.9):
    return OcrObservation(number=number, number_total=total, confidence=conf)


def test_rescale_floor():
    out = fusion.rescale(np.array([0.2, 0.3, 0.65, 1.0], np.float32), 0.3)
    assert out.tolist() == pytest.approx([0.0, 0.0, 0.5, 1.0])


def test_fuse_renormalises_over_present_signals():
    sig = {"emb_full": np.array([1.0, 0.5], np.float32)}
    raw = fusion.fuse_raw(sig, None)
    assert raw.tolist() == pytest.approx([1.0, 0.5])  # weight renormalised, not 0.4 * x
    raw2 = fusion.fuse_raw({**sig, "hash": np.array([1.0, 0.0], np.float32)}, None)
    assert raw2[0] == pytest.approx(1.0) and raw2[1] == pytest.approx((0.4 * 0.5) / 0.6)


def test_ocr_boost_penalty_never_a_gate():
    numbers = np.array([25, 26, 25], np.int32)
    official = np.array([193, 193, 100], np.int32)
    totals = np.array([200, 200, 100], np.int32)
    ag = fusion.ocr_agreement(_ocr(), numbers, official, totals)
    assert ag is not None
    assert ag.factor[0] == pytest.approx(1.45)  # number + total agree
    assert ag.factor[1] == pytest.approx(1 - 0.4 * 0.9)  # number mismatch: penalty, not removal
    assert ag.factor[2] == pytest.approx(1.0)  # number only: neutral
    assert (ag.score == np.array([1.0, 0.0, 0.5])).all()
    assert fusion.ocr_agreement(None, numbers, official, totals) is None
    assert fusion.ocr_agreement(OcrObservation(), numbers, official, totals) is None


def test_ocr_can_rescue_a_visually_weaker_card():
    sig = {"emb_full": np.array([0.80, 0.78], np.float32)}
    ag = fusion.ocr_agreement(_ocr(number=2, total=None), np.array([1, 2], np.int32),
                              np.zeros(2, np.int32), np.zeros(2, np.int32))
    raw = fusion.fuse_raw(sig, ag)
    order, _ = fusion.rank(raw, None, 3)
    assert order[0] == 1


def test_rank_mask_and_topk_cap():
    raw = np.array([0.9, 0.8, 0.7, 0.6, 0.5], np.float32)
    mask = np.array([False, True, True, True, True])
    order, conf = fusion.rank(raw, mask, 3)
    assert order.tolist() == [1, 2, 3] and len(conf) == 3
    assert conf[0] == pytest.approx(0.8) and conf[1] == pytest.approx(0.7 / 0.8 * 0.8)
    assert fusion.rank(raw, np.zeros(5, bool), 3)[0].size == 0


def test_decide_thresholds_and_margin():
    S = fusion.Status
    assert fusion.decide(np.array([0.9, 0.5], np.float32)) is S.MATCH
    assert fusion.decide(np.array([0.9, 0.85], np.float32)) is S.CANDIDATES  # margin rule
    assert fusion.decide(np.array([0.7, 0.2], np.float32)) is S.CANDIDATES
    assert fusion.decide(np.array([0.4, 0.1], np.float32)) is S.NO_MATCH
    assert fusion.decide(np.zeros(0, np.float32)) is S.NO_MATCH


# ---------------------------------------------------------------- variants
def _ref(**kw):
    base = dict(language="en", card_id="x-1", local_id="1", name="X", set_id="x", set_name="X",
                image_url=None, official_count=100, total_count=100, release_year=2020,
                has_reverse=False, has_first_edition=False, w_promo=False)
    base.update(kw)
    return CardRef(**base)


def test_variant_gates():
    card = make_card(2)
    assert assess_variants(card, _ref()) == ()
    kinds = {g.kind for g in assess_variants(card, _ref(has_reverse=True))}
    assert kinds == {VariantKind.REVERSE_HOLO}
    wotc = {g.kind for g in assess_variants(card, _ref(release_year=1999, has_first_edition=True))}
    assert wotc == {VariantKind.FIRST_EDITION, VariantKind.SHADOWLESS}
    assert {g.kind for g in assess_variants(card, _ref(w_promo=True))} == {VariantKind.PROMO_STAMP}


def test_reverse_holo_sparkle_scores_higher_than_flat():
    flat = np.full((constants.CARD_HEIGHT_PX, constants.CARD_WIDTH_PX, 3), 100, np.uint8)
    sparkle = flat.copy()
    sparkle += np.random.default_rng(0).integers(0, 120, sparkle.shape, dtype=np.uint8)
    ref = _ref(has_reverse=True)
    f = assess_variants(flat, ref)[0]
    s = assess_variants(sparkle, ref)[0]
    assert not f.present and s.present and s.confidence > f.confidence
    assert s.confidence <= constants.VARIANT_SINGLE_STILL_CONF_CAP


# ---------------------------------------------------------------- embedding
def test_select_output_rules():
    sel = embedding.OnnxEmbedder._select_output
    assert sel([("last_hidden_state", 3), ("pooler_output", 2)]) == ("pooler_output", False)
    assert sel([("last_hidden_state", 3)]) == ("last_hidden_state", True)
    assert sel([("emb", 2)]) == ("emb", False)
    with pytest.raises(embedding.ModelMissingError):
        sel([("weird", 4)])


def test_l2_normalize():
    v = embedding.l2_normalize(np.array([[3.0, 4.0], [0.0, 0.0]], np.float32))
    assert np.linalg.norm(v[0]) == pytest.approx(1.0) and np.allclose(v[1], 0)
