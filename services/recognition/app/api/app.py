"""FastAPI app: CORS allowlist, shared bearer token, 8 MB cap, 60/min/IP rate limit."""

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

from app.api.schemas import IdentifyResponse
from app.core import constants
from app.core.config import Settings
from app.recognize.pipeline import IndexNotReadyError, Recognizer

logger = logging.getLogger("flashydex.recognition.api")
SERVICE_VERSION = "0.1.0"
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

        async def limited_receive():  # noqa: ANN202
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.limit + 64 * 1024:
                    raise BodyTooLargeError
            return message

        async def tracking_send(message) -> None:  # noqa: ANN001
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except BodyTooLargeError:
            if not started:
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
    def __init__(self, per_minute: int) -> None:
        self.per_minute = per_minute
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str, now: float | None = None) -> float | None:
        """None when allowed, else seconds until the next slot frees up."""
        now = time.monotonic() if now is None else now
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] >= 60.0:
                hits.popleft()
            if len(hits) >= self.per_minute:
                return 60.0 - (now - hits[0])
            hits.append(now)
            if len(self._hits) > 4096:  # bound memory: drop idle keys
                for k in [k for k, v in self._hits.items() if not v or now - v[-1] >= 60.0]:
                    del self._hits[k]
            return None


def client_key(request: Request) -> str:
    fwd = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def create_app(settings: Settings | None = None, recognizer: Recognizer | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    if not settings.token and not settings.is_loopback:
        raise RuntimeError("FLASHYDEX_RECOG_TOKEN is required when binding a non-loopback host")
    limiter = RateLimiter(constants.RATE_LIMIT_PER_MIN)
    slots = threading.BoundedSemaphore(constants.MAX_CONCURRENT_IDENTIFY)
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
        if settings.token:
            header = request.headers.get("authorization", "")
            supplied = header[7:] if header.lower().startswith("bearer ") else ""
            if not hmac.compare_digest(supplied.encode(), settings.token.encode()):
                raise ApiError(401, "UNAUTHORIZED", "missing or invalid bearer token",
                               {"WWW-Authenticate": "Bearer"})
        elif not settings.is_loopback or any(h in request.headers for h in _PROXY_HEADERS):
            # No token configured: only direct loopback callers are allowed. A tunnel / reverse
            # proxy also arrives from 127.0.0.1, so proxy headers count as "remote".
            raise ApiError(401, "UNAUTHORIZED", "service requires FLASHYDEX_RECOG_TOKEN for remote callers",
                           {"WWW-Authenticate": "Bearer"})

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
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )
    return app
