"""FastAPI app: Origin gate (M2-D3), optional admin bearer token, 8 MB cap, rate limits."""

from __future__ import annotations

import hmac
import json
import logging
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.formparsers import MultiPartParser

from app.api.schemas import IdentifyResponse
from app.core import constants
from app.core.config import Settings
from app.recognize.pipeline import IndexNotReadyError, Recognizer

logger = logging.getLogger("flashydex.recognition.api")
SERVICE_VERSION = "0.1.0"
# Uploads up to MAX_UPLOAD_BYTES (+ multipart overhead) stay in an in-memory SpooledTemporaryFile;
# Starlette's default (1 MB) would spill larger photos to a temp file on disk.
MultiPartParser.spool_max_size = constants.MAX_UPLOAD_BYTES + 256 * 1024
_PROXY_HEADERS = ("cf-connecting-ip", "x-forwarded-for", "cf-ray", "forwarded")


class ApiError(HTTPException):
    def __init__(self, status: int, code: str, message: str, headers: dict[str, str] | None = None) -> None:
        super().__init__(status_code=status, detail={"code": code, "message": message}, headers=headers)


class BodyTooLargeError(Exception):
    pass


class BodyLimitMiddleware:
    """Rejects oversized ``/v1/identify`` bodies early (Content-Length and streamed byte count)."""

    def __init__(self, app, limit: int) -> None:  # noqa: ANN001
        self.app = app
        self.limit = limit

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope["type"] != "http" or scope["method"] != "POST" or not scope["path"].startswith("/v1/identify"):
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        declared = headers.get(b"content-length")
        started = False

        async def reject() -> None:
            body = json.dumps({"error": {"code": "IMAGE_TOO_LARGE",
                                         "message": f"image exceeds {self.limit // (1024 * 1024)} MB"}}).encode()
            await send({"type": "http.response.start", "status": 413,
                        "headers": [(b"content-type", b"application/json"),
                                    (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})

        if declared and declared.isdigit() and int(declared) > self.limit + 64 * 1024:
            return await reject()
        received = 0
        exceeded = False

        async def limited_receive():  # noqa: ANN202
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.limit + 64 * 1024:
                    exceeded = True
                    raise BodyTooLargeError
            return message

        async def tracking_send(message) -> None:  # noqa: ANN001
            nonlocal started
            if exceeded:
                # FastAPI turns a failed body read into a generic 400; replace it with the 413.
                if message["type"] == "http.response.start" and not started:
                    started = True
                    await reject()
                return
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except BodyTooLargeError:
            if not started:
                started = True
                await reject()


def sniff_image(data: bytes) -> str:
    """Return jpeg|png|webp, or raise the right 415."""
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[4:8] == b"ftyp" and data[8:12] in (b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1", b"heim",
                                                 b"heis", b"avif"):
        raise ApiError(415, "HEIC_UNSUPPORTED",
                       "HEIC/HEIF images are not supported yet; export as JPEG or PNG")
    raise ApiError(415, "UNSUPPORTED_IMAGE_TYPE", "only jpeg, png and webp images are accepted")


class RateLimiter:
    """Sliding windows. Per-client (minute + day) and one global (hour) budget.

    ``check`` is two-phase: nothing is recorded unless *every* window has room.
    """

    def __init__(self, per_minute: int, per_day: int = 10**9, global_per_hour: int = 10**9) -> None:
        self.per_minute = per_minute
        self.per_day = per_day
        self.global_per_hour = global_per_hour
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._global: deque[float] = deque()
        self._lock = threading.Lock()

    @staticmethod
    def _wait(hits: deque[float], now: float, window: float, limit: int) -> float | None:
        while hits and now - hits[0] >= window:
            hits.popleft()
        if len(hits) >= limit:
            return window - (now - hits[0])
        return None

    def check(self, key: str, now: float | None = None) -> float | None:
        """None when allowed (and recorded), else seconds until a slot frees up."""
        now = time.monotonic() if now is None else now
        with self._lock:
            hits = self._hits[key]
            waits = [
                self._wait(hits, now, 86400.0, self.per_day),
                self._wait(self._global, now, 3600.0, self.global_per_hour),
            ]
            # per-minute window is judged on the last 60 s of the (daily) deque
            recent = [t for t in hits if now - t < 60.0]
            if len(recent) >= self.per_minute:
                waits.append(60.0 - (now - recent[0]))
            blocked = [w for w in waits if w is not None]
            if blocked:
                return max(blocked)
            hits.append(now)
            self._global.append(now)
            if len(self._hits) > 4096:  # bound memory: drop idle keys
                for k in [k for k, v in self._hits.items() if not v or now - v[-1] >= 86400.0]:
                    del self._hits[k]
            return None


def is_loopback_peer(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return host in ("127.0.0.1", "::1", "localhost")


def client_key(request: Request) -> str:
    """CF-Connecting-IP only counts when the TCP peer is loopback (our own tunnel); else the peer IP."""
    peer = request.client.host if request.client else "unknown"
    if is_loopback_peer(request):
        cf = request.headers.get("cf-connecting-ip", "").strip()
        if cf:
            return cf
    return peer


def create_app(settings: Settings | None = None, recognizer: Recognizer | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    if not settings.token and not settings.is_loopback:
        raise RuntimeError("FLASHYDEX_RECOG_TOKEN is required when binding a non-loopback host")
    limiter = RateLimiter(settings.rate_per_min, settings.rate_per_day, settings.rate_global_per_hour)
    slots = threading.BoundedSemaphore(settings.max_concurrent)
    state: dict[str, object] = {"recognizer": recognizer, "error": None}

    @asynccontextmanager
    async def lifespan(_: FastAPI):  # noqa: ANN202
        if state["recognizer"] is None:
            try:
                state["recognizer"] = Recognizer.from_settings(settings)
            except Exception as error:  # noqa: BLE001 - serve /v1/health with the reason
                logger.exception("recognizer failed to start")
                state["error"] = f"{type(error).__name__}: {error}"
        yield

    app = FastAPI(title="FlashyDex recognition", version=SERVICE_VERSION, lifespan=lifespan)

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "HTTP_ERROR", "message": str(exc.detail)}
        return JSONResponse({"error": detail}, status_code=exc.status_code, headers=exc.headers)

    def auth(request: Request) -> None:
        """Gate for /v1/*: valid bearer (admin) OR allowlisted Origin OR direct loopback without proxy headers."""
        header = request.headers.get("authorization", "")
        if settings.token and header:
            supplied = header[7:] if header.lower().startswith("bearer ") else ""
            if hmac.compare_digest(supplied.encode(), settings.token.encode()):
                return
            raise ApiError(401, "UNAUTHORIZED", "missing or invalid bearer token", {"WWW-Authenticate": "Bearer"})
        origin = request.headers.get("origin", "")
        if origin:
            if not settings.origin_allowed(origin):
                raise ApiError(403, "ORIGIN_NOT_ALLOWED", "this origin may not use the recognition service")
        else:
            proxied = any(h in request.headers for h in _PROXY_HEADERS)
            if proxied or not is_loopback_peer(request):
                raise ApiError(403, "ORIGIN_NOT_ALLOWED", "requests must come from an allowed web origin")
        # Browsers always send Sec-Fetch-*; a typed URL / link navigation is not a fetch from our app.
        if request.headers.get("sec-fetch-mode", "").lower() == "navigate" or (
                request.method == "POST" and request.headers.get("sec-fetch-site", "").lower() == "none"):
            raise ApiError(403, "ORIGIN_NOT_ALLOWED", "navigation requests are not accepted")

    def rate_limit(request: Request) -> None:
        wait = limiter.check(client_key(request))
        if wait is not None:
            raise ApiError(429, "RATE_LIMITED", "too many requests", {"Retry-After": str(int(wait) + 1)})

    def current() -> Recognizer | None:
        return state["recognizer"]  # type: ignore[return-value]

    @app.get("/health")
    def liveness() -> dict[str, str]:
        """Unauthenticated liveness probe (tunnel / supervisor)."""
        return {"status": "ok"}

    @app.get("/v1/health", dependencies=[Depends(auth)])
    def health() -> dict:
        rec = current()
        index = rec.index if rec else None
        counts = ({lang: m["counts"]["cards"] for lang, m in index.manifests.items()}
                  if index is not None else {})
        return {
            "status": "ok" if index is not None else "degraded",
            "indexVersion": index.version if index is not None else None,
            "thresholds": {"match": constants.CONFIDENT_THRESHOLD, "margin": constants.CONFIDENT_MARGIN,
                           "candidates": constants.UNCERTAIN_THRESHOLD},
            "limits": {"perMinute": settings.rate_per_min, "perDay": settings.rate_per_day,
                       "globalPerHour": settings.rate_global_per_hour, "concurrent": settings.max_concurrent,
                       "maxUploadBytes": constants.MAX_UPLOAD_BYTES},
            "service": "flashydex-recognition",
            "version": SERVICE_VERSION,
            "model": constants.EMBED_MODEL_NAME,
            "embedder": rec.embedder.identifier if rec else None,
            "ocr": bool(rec and rec.ocr),
            "index": {"ready": index is not None, "languages": list(counts), "counts": counts,
                      "total": sum(counts.values()),
                      "version": index.version if index is not None else None},
            "error": state["error"],
        }

    @app.get("/v1/index/manifest", dependencies=[Depends(auth)])
    def manifest() -> dict:
        rec = current()
        if rec is None or rec.index is None:
            raise ApiError(503, "INDEX_NOT_READY", "no recognition index is loaded")
        return {"indexVersion": rec.index.version, "languages": rec.index.manifests}

    @app.post("/v1/identify", response_model=IdentifyResponse, dependencies=[Depends(auth), Depends(rate_limit)])
    async def identify(
        image: UploadFile = File(...),  # noqa: B008
        lang: str = Form("any"),
        max_candidates: int = Form(constants.DEFAULT_MAX_CANDIDATES),
    ) -> JSONResponse | dict:
        if lang not in ("en", "ja", "any"):
            raise ApiError(400, "INVALID_LANG", "lang must be en, ja or any")
        if not 1 <= max_candidates <= constants.MAX_CANDIDATES_CAP:
            raise ApiError(400, "INVALID_MAX_CANDIDATES", f"max_candidates must be 1..{constants.MAX_CANDIDATES_CAP}")
        data = await image.read(constants.MAX_UPLOAD_BYTES + 1)
        if len(data) > constants.MAX_UPLOAD_BYTES:
            raise ApiError(413, "IMAGE_TOO_LARGE", "image exceeds 8 MB")
        if not data:
            raise ApiError(400, "INVALID_IMAGE", "empty upload")
        sniff_image(data)
        rec = current()
        if rec is None:
            raise ApiError(503, "MODEL_MISSING", "recognition model failed to load; see /v1/health")
        if rec.index is None:
            raise ApiError(503, "INDEX_NOT_READY", "no recognition index is loaded")
        if not slots.acquire(blocking=False):
            raise ApiError(503, "BUSY", "recognizer is busy", {"Retry-After": "1"})
        try:
            from starlette.concurrency import run_in_threadpool

            result = await run_in_threadpool(
                rec.identify_bytes, data, lang=lang, max_candidates=max_candidates)
        except ValueError as error:
            raise ApiError(400, "INVALID_IMAGE", "image could not be decoded") from error
        except IndexNotReadyError as error:
            raise ApiError(503, "INDEX_NOT_READY", str(error)) from error
        finally:
            slots.release()
        # No PII: no IP, filename or image content is logged.
        logger.info("identify status=%s bytes=%d lang=%s total_ms=%.0f", result["status"], len(data), lang,
                    result["timingMs"].get("total", 0.0))
        return result

    app.add_middleware(BodyLimitMiddleware, limit=constants.MAX_UPLOAD_BYTES)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_origin_regex=settings.allowed_origin_regex or None,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        expose_headers=["Retry-After"],
        max_age=600,
    )
    return app
