"""Origin gate (M2-D3), rate limits, CORS-on-errors, oversize, ephemeral uploads. Fake recognizer, offline."""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path

import pytest

from app.api.app import RateLimiter, create_app
from app.core.config import Settings
from tests.test_api import JPG, FakeRecognizer, client, post

PROXY = {"CF-Connecting-IP": "203.0.113.9"}
GOOD = "https://flashydex.netlify.app"


def sec_client(**kw):
    """Client using the real default allowlist + regex."""
    from fastapi.testclient import TestClient

    peer = kw.pop("peer", "127.0.0.1")
    settings = Settings(**kw)
    return TestClient(create_app(settings, FakeRecognizer()), client=(peer, 50000))


@pytest.mark.parametrize(
    ("headers", "peer", "expected", "code"),
    [
        ({}, "127.0.0.1", 200, None),  # local curl / CLI / tests
        (PROXY, "127.0.0.1", 403, "ORIGIN_NOT_ALLOWED"),  # tunnel, no origin
        ({"X-Forwarded-For": "1.2.3.4"}, "127.0.0.1", 403, "ORIGIN_NOT_ALLOWED"),
        ({"CF-Ray": "abc"}, "127.0.0.1", 403, "ORIGIN_NOT_ALLOWED"),
        ({"Forwarded": "for=1.2.3.4"}, "127.0.0.1", 403, "ORIGIN_NOT_ALLOWED"),
        ({}, "192.168.1.9", 403, "ORIGIN_NOT_ALLOWED"),  # non-loopback peer, no origin
        ({**PROXY, "Origin": "https://evil.example"}, "127.0.0.1", 403, "ORIGIN_NOT_ALLOWED"),
        ({"Origin": "https://evil.example"}, "127.0.0.1", 403, "ORIGIN_NOT_ALLOWED"),
        ({**PROXY, "Origin": GOOD}, "127.0.0.1", 200, None),
        ({**PROXY, "Origin": "https://deploy-preview-12--flashydex.netlify.app"}, "127.0.0.1", 200, None),
        ({**PROXY, "Origin": "https://main--flashydex.netlify.app"}, "127.0.0.1", 200, None),
        ({**PROXY, "Origin": "https://evil--flashydex.netlify.app.evil.com"}, "127.0.0.1", 403, "ORIGIN_NOT_ALLOWED"),
        ({**PROXY, "Origin": "https://flashydex.netlify.app.evil.com"}, "127.0.0.1", 403, "ORIGIN_NOT_ALLOWED"),
        ({"Origin": "https://10.0.0.4:3200"}, "10.0.0.4", 200, None),
        ({"Origin": "http://127.0.0.1:3201"}, "127.0.0.1", 200, None),
        ({**PROXY, "Origin": GOOD, "Sec-Fetch-Site": "none"}, "127.0.0.1", 403, "ORIGIN_NOT_ALLOWED"),
        ({**PROXY, "Origin": GOOD, "Sec-Fetch-Mode": "navigate"}, "127.0.0.1", 403, "ORIGIN_NOT_ALLOWED"),
        ({**PROXY, "Origin": GOOD, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors"}, "127.0.0.1", 200, None),
        ({"Sec-Fetch-Site": "none"}, "127.0.0.1", 403, "ORIGIN_NOT_ALLOWED"),
    ],
)
def test_origin_gate_matrix(headers, peer, expected, code):
    r = post(sec_client(peer=peer), JPG, headers)
    assert r.status_code == expected, r.text
    if code:
        assert r.json()["error"]["code"] == code


def test_gate_applies_to_all_v1_but_not_liveness():
    c = sec_client()
    assert c.get("/v1/health", headers=PROXY).status_code == 403
    assert c.get("/v1/index/manifest", headers=PROXY).status_code == 403
    assert c.get("/health", headers=PROXY).status_code == 200
    assert c.get("/v1/health", headers={**PROXY, "Origin": GOOD}).status_code == 200


def test_valid_token_bypasses_origin_but_bad_token_is_401():
    c = sec_client(token="tok", peer="127.0.0.1")
    assert post(c, JPG, {**PROXY, "Authorization": "Bearer tok"}).status_code == 200
    assert post(c, JPG, {**PROXY, "Authorization": "Bearer wrong"}).status_code == 401


def test_env_overrides_for_origins(monkeypatch):
    monkeypatch.setenv("FLASHYDEX_RECOG_ALLOWED_ORIGINS", "https://only.example")
    monkeypatch.setenv("FLASHYDEX_RECOG_ALLOWED_ORIGIN_REGEX", r"^https://x\d+\.example$")
    s = Settings.from_env()
    assert s.origin_allowed("https://only.example") and s.origin_allowed("https://x12.example")
    assert not s.origin_allowed(GOOD)


def test_default_allowlist_contents():
    s = Settings()
    for origin in ("https://flashydex.netlify.app", "https://localhost:3200", "https://127.0.0.1:3200",
                   "https://10.0.0.4:3200", "http://127.0.0.1:3201", "http://127.0.0.1:3203",
                   "http://localhost:3201", "http://localhost:3203"):
        assert s.origin_allowed(origin), origin


def test_cors_headers_on_error_responses():
    c = sec_client()
    # 415 for allowlisted origin carries ACAO + readable body
    r = post(c, b"not an image", {"Origin": GOOD, **PROXY})
    assert r.status_code == 415 and r.headers["access-control-allow-origin"] == GOOD
    assert r.json()["error"]["code"] == "UNSUPPORTED_IMAGE"
    # 413
    big = b"\xff\xd8\xff" + b"0" * (8 * 1024 * 1024 + 300_000)
    r = post(c, big, {"Origin": GOOD, **PROXY})
    assert r.status_code == 413 and r.headers["access-control-allow-origin"] == GOOD
    # 503 INDEX_NOT_READY
    from fastapi.testclient import TestClient

    nc = TestClient(create_app(Settings(), FakeRecognizer(ready=False)), client=("127.0.0.1", 1))
    r = post(nc, JPG, {"Origin": GOOD, **PROXY})
    assert r.status_code == 503 and r.headers["access-control-allow-origin"] == GOOD
    # 429 exposes Retry-After
    lc = sec_client(rate_per_min=1)
    post(lc, JPG, {"Origin": GOOD, **PROXY})
    r = post(lc, JPG, {"Origin": GOOD, **PROXY})
    assert r.status_code == 429 and r.headers["access-control-allow-origin"] == GOOD
    assert int(r.headers["retry-after"]) >= 1
    # preflight from a deploy preview succeeds, from evil does not
    pre = c.options("/v1/identify", headers={"Origin": "https://pr-3--flashydex.netlify.app",
                                              "Access-Control-Request-Method": "POST"})
    assert pre.headers["access-control-allow-origin"] == "https://pr-3--flashydex.netlify.app"
    bad = c.options("/v1/identify", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in bad.headers
    # 403 for a disallowed origin carries NO CORS header (browser cannot read it, by design)
    r = post(c, JPG, {"Origin": "https://evil.example"})
    assert r.status_code == 403 and "access-control-allow-origin" not in r.headers


def test_rate_limit_per_client_and_retry_after():
    c = sec_client(rate_per_min=3)
    hdr = {"Origin": GOOD, "CF-Connecting-IP": "198.51.100.1"}
    codes = [post(c, JPG, hdr).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]
    r = post(c, JPG, hdr)
    assert r.json()["error"]["code"] == "RATE_LIMITED" and int(r.headers["retry-after"]) >= 1
    # a different client (different CF-Connecting-IP via loopback peer) has its own budget
    assert post(c, JPG, {"Origin": GOOD, "CF-Connecting-IP": "198.51.100.2"}).status_code == 200


def test_rate_limit_global_and_daily():
    c = sec_client(rate_global_per_hour=4)
    codes = [post(c, JPG, {"Origin": GOOD, "CF-Connecting-IP": f"198.51.100.{i}"}).status_code for i in range(6)]
    assert codes == [200, 200, 200, 200, 429, 429]
    limiter = RateLimiter(30, 5, 600)
    assert all(limiter.check("a", now=float(i) * 100) is None for i in range(5))
    wait = limiter.check("a", now=600.0)
    assert wait is not None and wait > 80000


def test_x_forwarded_for_not_trusted_from_non_loopback_peer():
    # peer is not loopback: spoofed CF-Connecting-IP must not give a fresh budget
    c = sec_client(rate_per_min=2, peer="10.0.0.4")
    codes = [post(c, JPG, {"Origin": "https://10.0.0.4:3200", "CF-Connecting-IP": f"9.9.9.{i}",
                           "X-Forwarded-For": f"8.8.8.{i}"}).status_code for i in range(3)]
    assert codes == [200, 200, 429]


def test_streamed_chunked_body_over_limit_413():
    c = sec_client()

    def chunks():
        yield b"--b\r\nContent-Disposition: form-data; name=\"image\"; filename=\"a.jpg\"\r\n\r\n"
        for _ in range(10):
            yield b"\xff\xd8\xff" + b"0" * (1024 * 1024)
        yield b"\r\n--b--\r\n"

    r = c.post("/v1/identify", content=chunks(), headers={"Content-Type": "multipart/form-data; boundary=b"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_content_length_over_limit_413():
    c = sec_client()
    r = c.post("/v1/identify", content=b"x", headers={"Content-Length": str(50 * 1024 * 1024),
               "Content-Type": "multipart/form-data; boundary=b"})
    assert r.status_code in (413, 400)


def test_heic_accepted_when_pillow_heif_present():
    from app.vision.imaging import heif_available

    assert heif_available()  # pinned in requirements.txt
    heic = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heicmif1"
    assert post(client(), heic).status_code == 200  # sniffed as HEIC (fake recognizer ignores the payload)


def test_invalid_lang_code():
    r = post(client(), JPG, lang="fr")
    assert r.status_code == 400 and r.json()["error"]["code"] == "INVALID_LANG"


def test_uploads_stay_in_memory_and_logs_are_clean(caplog, monkeypatch):
    import numpy as np
    from app.synth import jpeg_bytes

    rng = np.random.default_rng(0)
    big = jpeg_bytes(rng.integers(0, 255, (1650, 1650, 3), dtype=np.uint8), 95)
    assert 2.5e6 < len(big) < 8e6, len(big)
    tmp = Path(tempfile.gettempdir())
    data_dir = Path(__file__).resolve().parents[1] / "data"

    def snapshot():
        import os

        top = {p.name for p in tmp.iterdir()}  # SpooledTemporaryFile spills land at the top level
        written = {}
        for root, dirs, files in os.walk(data_dir):
            dirs[:] = [d for d in dirs if d not in ("logs", "cache", "eval-results")]
            for f in files:
                path = Path(root) / f
                written[str(path)] = path.stat().st_mtime_ns
        return top, written

    import tempfile as tf

    rollovers: list[int] = []
    orig = tf.SpooledTemporaryFile.rollover
    monkeypatch.setattr(tf.SpooledTemporaryFile, "rollover", lambda self: (rollovers.append(1), orig(self))[1])
    c = sec_client()
    before = snapshot()
    with caplog.at_level(logging.DEBUG):
        for _ in range(5):
            r = post(c, big, {"Origin": GOOD, **PROXY}, lang="en")
            assert r.status_code == 200
    after = snapshot()
    # other processes (index build, other tests) may create small temp files concurrently; an image spill is >1 MB
    leaked = [n for n in after[0] - before[0] if (tmp / n).is_file() and (tmp / n).stat().st_size > 1_000_000]
    assert leaked == [], "image-sized temp files created by identify"
    assert rollovers == [], "SpooledTemporaryFile spilled an upload to disk"
    assert after[1] == before[1], "files written under data/ by identify"
    text = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "card.jpg" not in text and "203.0.113.9" not in text and "base64" not in text.lower()
    assert "\xff\xd8" not in text
    assert any("identify status=" in rec.getMessage() for rec in caplog.records)
