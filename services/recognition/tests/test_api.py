"""API contract tests with a fake Recognizer (no model, no network)."""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api import app as api_app
from app.api.app import RateLimiter, create_app
from app.core import constants
from app.core.config import Settings
from app.index.store import LoadedIndex
from app.synth import jpeg_bytes, make_card

ORIGIN = "https://localhost:3200"


class FakeEmbedder:
    identifier = "fake:embedder"


class FakeRecognizer:
    embedder = FakeEmbedder()
    ocr = None

    def __init__(self, ready: bool = True) -> None:
        self.index = (
            LoadedIndex(cards=[], languages=["en"], lang_of_row=np.array([]), emb_full=np.zeros((0, 4)),
                        emb_art=np.zeros((0, 4)), hashes=np.zeros((0, 5, 32), np.uint8),
                        numbers=np.zeros(0, np.int32), official=np.zeros(0, np.int32), totals=np.zeros(0, np.int32),
                        manifests={"en": {"counts": {"cards": 1}, "indexVersion": "v1"}}, version="en:v1",
                        embedder="fake:embedder") if ready else None
        )
        self.calls: list[tuple[str, int]] = []

    def identify_bytes(self, data, *, lang="any", max_candidates=3):  # noqa: ANN001
        self.calls.append((lang, max_candidates))
        return {
            "status": "candidates", "confidence": 0.7, "timingMs": {"total": 1.0}, "indexVersion": "en:v1",
            "detection": {"quadFound": True, "fallback": "none"}, "ocr": None,
            "candidates": [{
                "language": "en", "cardId": "swsh3-136", "localId": "136", "name": "Furret", "setId": "swsh3",
                "setName": "Darkness Ablaze", "imageUrl": "https://assets.tcgdex.net/en/swsh/swsh3/136/low.webp",
                "score": 0.7, "signals": {"hash": 0.5, "embed": 0.9, "ocr": None, "symbol": None},
                "variantHints": {"reverseHolo": 0.3}}],
        }


def client(token: str = "", host: str = "127.0.0.1", rec: FakeRecognizer | None = None) -> TestClient:
    settings = Settings(host=host, token=token, allowed_origins=(ORIGIN,))
    return TestClient(create_app(settings, rec or FakeRecognizer()))


def post(c: TestClient, data: bytes, headers: dict | None = None, **form):
    return c.post("/v1/identify", files={"image": ("card.jpg", data, "image/jpeg")}, data=form, headers=headers or {})


JPG = jpeg_bytes(make_card(1))


def test_identify_ok_and_contract_shape():
    rec = FakeRecognizer()
    r = post(client(rec=rec), JPG, lang="en", max_candidates="2")
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"status", "confidence", "candidates", "timingMs", "indexVersion"}
    cand = body["candidates"][0]
    assert set(cand) == {"language", "cardId", "localId", "name", "setId", "setName", "imageUrl", "score",
                         "signals", "variantHints"}
    assert rec.calls == [("en", 2)]


def test_validation_errors():
    c = client()
    assert post(c, JPG, lang="fr").status_code == 400
    assert post(c, JPG, max_candidates="6").status_code == 400
    assert post(c, b"").status_code == 400
    r = post(c, b"not an image at all")
    assert r.status_code == 415 and r.json()["error"]["code"] == "UNSUPPORTED_IMAGE_TYPE"
    heic = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heicmif1"
    r = post(c, heic)
    assert r.status_code == 415 and r.json()["error"]["code"] == "HEIC_UNSUPPORTED"


def test_size_cap_8mb():
    big = b"\xff\xd8\xff" + b"0" * (constants.MAX_UPLOAD_BYTES + 200_000)
    r = post(client(), big)
    assert r.status_code == 413 and r.json()["error"]["code"] == "IMAGE_TOO_LARGE"


def test_token_required_when_set():
    c = client(token="s3cret")
    assert post(c, JPG).status_code == 401
    assert post(c, JPG, {"Authorization": "Bearer nope"}).status_code == 401
    assert post(c, JPG, {"Authorization": "Bearer s3cret"}).status_code == 200
    assert c.get("/v1/health").status_code == 401
    assert c.get("/v1/health", headers={"Authorization": "Bearer s3cret"}).status_code == 200
    assert c.get("/health").status_code == 200  # liveness stays open


def test_no_token_only_for_direct_loopback():
    c = client(token="")
    assert post(c, JPG).status_code == 200
    # a tunnel/reverse proxy also connects from 127.0.0.1: proxy headers => treated as remote
    assert post(c, JPG, {"CF-Connecting-IP": "203.0.113.9"}).status_code == 401


def test_refuses_public_bind_without_token():
    with pytest.raises(RuntimeError):
        create_app(Settings(host="0.0.0.0", token=""), FakeRecognizer())


def test_cors_allowlist():
    c = client()
    ok = c.options("/v1/identify", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "POST",
                                            "Access-Control-Request-Headers": "authorization"})
    assert ok.headers.get("access-control-allow-origin") == ORIGIN
    bad = c.options("/v1/identify", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in bad.headers
    # errors still carry CORS headers so the browser can read them
    r = c.get("/v1/health", headers={"Origin": ORIGIN})
    assert r.headers.get("access-control-allow-origin") == ORIGIN


def test_rate_limit_60_per_minute():
    limiter = RateLimiter(60)
    assert all(limiter.check("ip", now=float(i) * 0.1) is None for i in range(60))
    assert limiter.check("ip", now=6.5) is not None
    assert limiter.check("ip", now=61.0) is None  # window slid
    assert limiter.check("other", now=6.5) is None
    c = client()
    codes = [post(c, JPG).status_code for _ in range(62)]
    assert codes.count(200) == 60 and codes[-1] == 429


def test_index_not_ready_and_health():
    c = client(rec=FakeRecognizer(ready=False))
    r = post(c, JPG)
    assert r.status_code == 503 and r.json()["error"]["code"] == "INDEX_NOT_READY"
    h = c.get("/v1/health").json()
    assert h["status"] == "degraded" and h["index"]["ready"] is False
    ok = client().get("/v1/health").json()
    assert ok["index"]["ready"] and ok["model"] == "onnx-community/dinov2-small" and ok["index"]["total"] == 1
    assert client().get("/v1/index/manifest").json()["indexVersion"] == "en:v1"


def test_busy_when_slots_exhausted(monkeypatch):
    monkeypatch.setattr(api_app.constants, "MAX_CONCURRENT_IDENTIFY", 0)
    r = post(client(), JPG)
    assert r.status_code == 503 and r.json()["error"]["code"] == "BUSY"
