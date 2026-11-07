"""M2 service tests: fusion calibration, health, X-FDX-Client-IP trust, error bodies, HEIC, index verify,
ephemeral processing with the REAL pipeline (skipped when the model/index are not on disk)."""

from __future__ import annotations

import io
import json
import logging
import os
import random
import sqlite3
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api.app import create_app
from app.core import constants
from app.core.config import Settings
from app.models import OcrObservation
from app.recognize import fusion
from tests.test_api import JPG, FakeRecognizer, client, post
from tests.test_security import GOOD, sec_client

SERVICE = Path(__file__).resolve().parents[1]
REFERENCE = SERVICE / "data" / "cache" / "images" / "en" / "swsh3-136.webp"
HAVE_REAL = (REFERENCE.is_file() and (SERVICE / "data" / "index" / "en" / "index-manifest.json").is_file()
             and (SERVICE / "data" / "index" / "ja" / "index-manifest.json").is_file()
             and (SERVICE / "data" / "models" / constants.EMBED_MODEL_FILE).is_file())
real_only = pytest.mark.skipif(not HAVE_REAL, reason="model/index/reference image not on disk")


# -- fusion calibration -------------------------------------------------------------------
def _perfect_sigs(n: int = 4) -> dict[str, np.ndarray]:
    others = np.full(n - 1, 0.15, np.float32)
    top = np.array([1.0], np.float32)
    return {"emb_full": np.concatenate([top, others]), "emb_art": np.concatenate([top, others]),
            "hash": np.concatenate([top, np.full(n - 1, 0.05, np.float32)])}


def test_no_digits_read_is_neutral_not_a_penalty():
    numbers, official, totals = np.array([136, 36, 12, 5]), np.zeros(4, np.int32), np.zeros(4, np.int32)
    for obs in (None, OcrObservation(), OcrObservation(raw_text="Furret", confidence=0.9)):
        assert fusion.ocr_agreement(obs, numbers, official, totals) is None
    sigs = _perfect_sigs()
    raw = fusion.fuse_raw(sigs, None)
    order, conf = fusion.rank(raw, None, 3)
    assert conf[0] == pytest.approx(1.0) and fusion.decide(conf) is fusion.Status.MATCH


def test_exact_reference_is_match_even_when_ocr_misreads_digits():
    """The M2 director defect: hash 1.0 + embed 1.0 but OCR read '36/9' (real card is 136/189)."""
    numbers, official, totals = np.array([136, 36, 12, 5]), np.array([189, 9, 0, 0]), np.zeros(4, np.int32)
    agreement = fusion.ocr_agreement(OcrObservation(number=36, number_total=9, confidence=0.503),
                                     numbers, official, totals)
    assert agreement is not None and agreement.score[0] == 0.0  # the true card disagrees with the (wrong) read
    raw = fusion.fuse_raw(_perfect_sigs(), agreement)
    order, conf = fusion.rank(raw, None, 3)
    assert order[0] == 0
    assert conf[0] >= 0.99 and fusion.decide(conf) is fusion.Status.MATCH


def test_ocr_agreement_still_boosts_and_breaks_ties():
    numbers, official, totals = np.array([1, 2]), np.array([100, 100]), np.zeros(2, np.int32)
    agreement = fusion.ocr_agreement(OcrObservation(number=2, number_total=100, confidence=0.9),
                                     numbers, official, totals)
    sigs = {"emb_full": np.array([0.80, 0.78], np.float32), "emb_art": np.array([0.80, 0.78], np.float32),
            "hash": np.array([0.5, 0.5], np.float32)}
    order, _ = fusion.rank(fusion.fuse_raw(sigs, agreement), None, 2)
    assert order[0] == 1


# -- health -------------------------------------------------------------------------------
class WarmableRecognizer(FakeRecognizer):
    def __init__(self, ready: bool = True, fail_warm: bool = False) -> None:
        super().__init__(ready)
        self.warmed = 0
        self.fail_warm = fail_warm

    def warm_up(self) -> None:
        if self.fail_warm:
            raise RuntimeError("no model")
        self.warmed += 1


def _health_client(rec, **kw):
    settings = Settings(allowed_origins=("https://localhost:3200",), **kw)
    return TestClient(create_app(settings, rec), client=("127.0.0.1", 50000))


def test_health_ready_only_after_both_indexes_and_warm_up():
    rec = WarmableRecognizer()
    rec.index.manifests = {"en": {"counts": {"cards": 5}, "indexVersion": "v1", "catalogVersion": "2026.1"},
                           "ja": {"counts": {"cards": 2}, "indexVersion": "v1", "catalogVersion": "2026.1"}}
    rec.index.version = "en:v1|ja:v1"
    with _health_client(rec, langs=("en", "ja")) as c:
        h = c.get("/v1/health").json()
        assert rec.warmed == 1
        assert h["ready"] is True and h["warm"] is True and h["status"] == "ok"
        assert h["counts"] == {"en": 5, "ja": 2} and h["catalogVersion"] == "2026.1"
        assert h["indexVersion"] == "en:v1|ja:v1" and h["lastIdentifyMs"] is None and h["uptimeSec"] >= 0
        assert post(c, JPG).status_code == 200
        assert c.get("/v1/health").json()["lastIdentifyMs"] == 1.0  # FakeRecognizer reports total=1.0


def test_health_not_ready_when_an_index_is_missing_or_warmup_fails():
    with _health_client(WarmableRecognizer(), langs=("en", "ja")) as c:  # fake index only has "en"
        h = c.get("/v1/health").json()
        assert h["ready"] is False and h["status"] == "degraded" and h["counts"] == {"en": 1}
    with _health_client(WarmableRecognizer(fail_warm=True), langs=("en",)) as c:
        h = c.get("/v1/health").json()
        assert h["ready"] is False and h["warm"] is False and "warm-up" in h["error"]
    with _health_client(WarmableRecognizer(ready=False), langs=("en",)) as c:
        assert c.get("/v1/health").json()["ready"] is False


def test_health_before_lifespan_is_not_warm():
    h = _health_client(WarmableRecognizer(), langs=("en",)).get("/v1/health").json()  # no `with`: no startup
    assert h["warm"] is False and h["ready"] is False


# -- X-FDX-Client-IP ----------------------------------------------------------------------
def _ip(i: int) -> dict:
    return {"X-FDX-Client-IP": f"198.51.100.{i}"}


def test_client_ip_header_keys_the_limit_only_with_valid_bearer():
    c = sec_client(token="tok", rate_per_min=2)
    auth = {"Authorization": "Bearer tok"}
    assert [post(c, JPG, {**auth, **_ip(1)}).status_code for _ in range(3)] == [200, 200, 429]
    assert post(c, JPG, {**auth, **_ip(2)}).status_code == 200  # a different end user has a fresh budget
    # same user is still blocked even though the call comes through the same loopback tunnel
    assert post(c, JPG, {**auth, **_ip(1)}).status_code == 429
    # garbage header value is ignored: falls back to the shared tunnel/peer key
    assert post(c, JPG, {**auth, "X-FDX-Client-IP": "not-an-ip"}).status_code == 200
    assert post(c, JPG, {**auth, "X-FDX-Client-IP": "not-an-ip"}).status_code == 200
    assert post(c, JPG, {**auth, "X-FDX-Client-IP": "not-an-ip"}).status_code == 429


def test_client_ip_header_is_ignored_or_rejected_without_bearer():
    c = sec_client(token="tok", rate_per_min=2)
    # no bearer, no Origin: proxy-header rule rejects it
    r = post(c, JPG, _ip(1))
    assert r.status_code == 401 and r.json()["error"]["code"] == "UNAUTHORIZED"
    # allowed Origin but no bearer: never authorized, so the header cannot mint a rate-limit budget
    codes = [post(c, JPG, {"Origin": GOOD, **_ip(i)}).status_code for i in range(3)]
    assert codes == [401, 401, 401]
    # wrong bearer: 401 regardless of the header
    assert post(c, JPG, {"Authorization": "Bearer nope", **_ip(1)}).status_code == 401


# -- error bodies -------------------------------------------------------------------------
def test_every_error_has_code_message_retryable():
    c = client()
    cases = [
        (post(c, b"junk"), 415, "UNSUPPORTED_IMAGE", False),
        (post(client(max_concurrent=0), JPG), 503, "RECOGNIZER_BUSY", True),
        (post(client(), b"\xff\xd8\xff" + b"0" * (constants.MAX_UPLOAD_BYTES + 200_000)), 413, "PAYLOAD_TOO_LARGE",
         False),
        (post(client(token="t"), JPG, {"Authorization": "Bearer x"}), 401, "UNAUTHORIZED", False),
        (post(client(), JPG, lang="fr"), 400, "INVALID_LANG", False),
        (post(client(rec=FakeRecognizer(ready=False)), JPG), 503, "INDEX_NOT_READY", True),
        (c.get("/v1/nope"), 404, "HTTP_ERROR", False),
        (c.post("/v1/identify", data={"lang": "en"}), 422, "INVALID_REQUEST", False),
    ]
    for response, status, code, retryable in cases:
        body = response.json()
        assert response.status_code == status, (code, response.text)
        assert set(body) == {"error"} and set(body["error"]) == {"code", "message", "retryable"}, body
        assert body["error"]["code"] == code and body["error"]["retryable"] is retryable, body
        assert isinstance(body["error"]["message"], str) and body["error"]["message"]
    rl = client(rate_per_min=1)
    post(rl, JPG)
    r = post(rl, JPG)
    assert r.status_code == 429 and r.json()["error"] == {
        "code": "RATE_LIMITED", "message": "too many requests", "retryable": True}


# -- HEIC ---------------------------------------------------------------------------------
def test_heic_decodes_end_to_end():
    pillow_heif = pytest.importorskip("pillow_heif")
    from PIL import Image

    from app.api.app import sniff_image
    from app.vision.imaging import decode_upload

    pillow_heif.register_heif_opener()
    arr = (np.random.default_rng(3).random((120, 90, 3)) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="HEIF", quality=80)
    data = buf.getvalue()
    assert data[4:8] == b"ftyp" and sniff_image(data) == "heic"
    out = decode_upload(data)
    assert out.shape == (120, 90, 3) and out.dtype == np.uint8


# -- index verify -------------------------------------------------------------------------
def test_index_verify_reports_orphans_and_missing(tmp_path):
    from app.index.verify import verify

    db = tmp_path / "catalog-en-2026.1.db"
    con = sqlite3.connect(db)
    con.executescript("""
        CREATE TABLE catalog_meta (id text, language text, version text);
        INSERT INTO catalog_meta VALUES ('catalog', 'en', '2026.1');
        CREATE TABLE catalog_sets (language text, id text, name text, series text, official_count int,
                                   total_count int, release_date text);
        INSERT INTO catalog_sets VALUES ('en','s1','Set One','swsh',10,12,'2020-01-01');
        CREATE TABLE catalog_cards (language text, id text, set_id text, local_id text, local_id_sort text,
            name text, image_url text, has_reverse int, has_first_edition int, w_promo int);
        INSERT INTO catalog_cards VALUES ('en','s1-1','s1','1','001','A','http://x/1',0,0,0);
        INSERT INTO catalog_cards VALUES ('en','s1-2','s1','2','002','B','http://x/2',0,0,0);
        INSERT INTO catalog_cards VALUES ('en','s1-3','s1','3','003','C',NULL,0,0,0);
    """)
    con.commit()
    con.close()
    index_dir = tmp_path / "data" / "index" / "en"
    index_dir.mkdir(parents=True)
    (index_dir / "ids.json").write_text(json.dumps(["s1-1", "gone-9"]))
    report = verify(Settings(data_dir=tmp_path / "data"), [db])
    en = report["languages"]["en"]
    assert report["ok"] is False
    assert en["orphans"] == 1 and en["orphanIds"] == ["gone-9"]
    assert en["scannableCardsNotIndexed"] == 1 and en["scannableNotIndexedIds"] == ["s1-2"]
    assert en["catalogCards"] == 3 and en["catalogCardsWithImage"] == 2 and en["indexed"] == 2


# -- real pipeline ------------------------------------------------------------------------
@pytest.fixture(scope="module")
def real_client():
    from app.recognize.pipeline import Recognizer

    settings = Settings()
    rec = Recognizer.from_settings(settings)
    with TestClient(create_app(settings, rec), client=("127.0.0.1", 50000)) as c:
        yield c


def _png(rgb: np.ndarray) -> bytes:
    import cv2

    return cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))[1].tobytes()


@real_only
def test_real_reference_image_is_a_match(real_client):
    h = real_client.get("/v1/health").json()
    assert h["ready"] is True and h["warm"] is True and set(h["counts"]) == {"en", "ja"}
    r = real_client.post("/v1/identify", files={"image": ("x.webp", REFERENCE.read_bytes(), "image/webp")},
                         data={"lang": "en"})
    body = r.json()
    assert r.status_code == 200 and body["status"] == "match", body
    assert body["candidates"][0]["cardId"] == "swsh3-136" and body["confidence"] >= 0.95


@real_only
def test_real_rotations_identify_the_right_card(real_client):
    import cv2

    ref = cv2.cvtColor(cv2.imread(str(REFERENCE)), cv2.COLOR_BGR2RGB)
    ref = cv2.resize(ref, (constants.CARD_WIDTH_PX, constants.CARD_HEIGHT_PX), interpolation=cv2.INTER_CUBIC)
    for k in (1, 2, 3):
        r = real_client.post("/v1/identify", files={"image": ("x.png", _png(np.rot90(ref, k).copy()), "image/png")},
                             data={"lang": "en"})
        body = r.json()
        assert r.status_code == 200 and body["candidates"], (k, body)
        assert body["candidates"][0]["cardId"] == "swsh3-136", (k, body["candidates"][0]["cardId"])


@real_only
def test_real_identify_writes_nothing_under_data_and_logs_no_content(real_client, caplog):
    """Ephemeral processing: photos live in memory only; no filenames / image bytes in logs."""
    import cv2

    from app.eval import t_photo1600

    data_dir = SERVICE / "data"

    def snapshot() -> dict[str, tuple[int, int]]:
        found = {}
        for root, dirs, files in os.walk(data_dir):
            dirs[:] = [d for d in dirs if d != "logs"]  # logs are the one place the service may write
            for name in files:
                path = Path(root) / name
                st = path.stat()
                found[str(path)] = (st.st_mtime_ns, st.st_size)
            for d in dirs:
                found[str(Path(root) / d) + "/"] = (0, 0)  # directory listing
        return found

    ref = cv2.cvtColor(cv2.imread(str(REFERENCE)), cv2.COLOR_BGR2RGB)
    ref = cv2.resize(ref, (constants.CARD_WIDTH_PX, constants.CARD_HEIGHT_PX), interpolation=cv2.INTER_CUBIC)
    photo = t_photo1600(REFERENCE.read_bytes(), ref, random.Random(1))
    uploads = [("secret-holiday-photo.jpg", photo, "image/jpeg"),
               ("swsh3-136.webp", REFERENCE.read_bytes(), "image/webp")]
    before = snapshot()
    with caplog.at_level(logging.DEBUG):
        for name, data, mime in uploads:
            r = real_client.post("/v1/identify", files={"image": (name, data, mime)}, data={"lang": "en"})
            assert r.status_code == 200
    after = snapshot()
    assert after == before, sorted(set(after.items()) ^ set(before.items()))[:5]
    text = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "secret-holiday-photo" not in text and "swsh3-136.webp" not in text
    assert "RIFF" not in text and "\xff\xd8" not in text and "JFIF" not in text and "\\xff\\xd8" not in text
    assert any("identify status=" in rec.getMessage() for rec in caplog.records)
