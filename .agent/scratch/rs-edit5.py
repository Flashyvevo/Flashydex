import pathlib

p = pathlib.Path("app/api/app.py")
s = p.read_bytes().decode().replace("\r\n", "\n")


def rep(old: str, new: str, count: int = 1) -> None:
    global s
    assert s.count(old) >= 1, old[:60]
    s = s.replace(old, new, count)


rep("import hmac\nimport json\n", "import hmac\nimport ipaddress\nimport json\n")
rep("from fastapi import Depends", "import numpy as np\nfrom fastapi import Depends")
rep("from fastapi.responses import JSONResponse\n",
    "from fastapi.exceptions import RequestValidationError\nfrom fastapi.responses import JSONResponse\n")
rep("from starlette.formparsers import MultiPartParser\n",
    "from starlette.exceptions import HTTPException as StarletteHTTPException\nfrom starlette.formparsers import MultiPartParser\n")
rep('_PROXY_HEADERS = ("cf-connecting-ip", "x-forwarded-for", "cf-ray", "forwarded")\n',
    '''_PROXY_HEADERS = ("cf-connecting-ip", "x-forwarded-for", "cf-ray", "forwarded", "x-fdx-client-ip")
# Contract error codes (.agent/m2-contract.md): which ones tell the client "try again".
_RETRYABLE = frozenset({"RECOGNIZER_BUSY", "RATE_LIMITED", "INDEX_NOT_READY", "MODEL_MISSING"})
''')
rep('''class ApiError(HTTPException):
    def __init__(self, status: int, code: str, message: str, headers: dict[str, str] | None = None) -> None:
        super().__init__(status_code=status, detail={"code": code, "message": message}, headers=headers)
''', '''def error_body(code: str, message: str) -> dict:
    """Every service error: ``{ error: { code, message, retryable } }``."""
    return {"error": {"code": code, "message": message, "retryable": code in _RETRYABLE}}


class ApiError(HTTPException):
    def __init__(self, status: int, code: str, message: str, headers: dict[str, str] | None = None) -> None:
        super().__init__(status_code=status, detail={"code": code, "message": message}, headers=headers)
''')
rep('''            body = json.dumps({"error": {"code": "IMAGE_TOO_LARGE",
                                         "message": f"image exceeds {self.limit // (1024 * 1024)} MB"}}).encode()''',
    '''            body = json.dumps(error_body("PAYLOAD_TOO_LARGE",
                                         f"image exceeds {self.limit // (1024 * 1024)} MB")).encode()''')
rep('''def sniff_image(data: bytes) -> str:
    """Return jpeg|png|webp, or raise the right 415."""''', '''def sniff_image(data: bytes) -> str:
    """Return jpeg|png|webp|heic, or raise the right 415 (``UNSUPPORTED_IMAGE``)."""''')
rep('''    if data[4:8] == b"ftyp" and data[8:12] in (b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1", b"heim",
                                                 b"heis", b"avif"):
        raise ApiError(415, "HEIC_UNSUPPORTED",
                       "HEIC/HEIF images are not supported yet; export as JPEG or PNG")
    raise ApiError(415, "UNSUPPORTED_IMAGE_TYPE", "only jpeg, png and webp images are accepted")''',
    '''    if data[4:8] == b"ftyp" and data[8:12] in HEIC_BRANDS:
        if heif_available():
            return "heic"
        raise ApiError(415, "UNSUPPORTED_IMAGE", "HEIC/HEIF images are not supported; export as JPEG or PNG")
    if data[4:8] == b"ftyp":  # avif and other ISO-BMFF brands we cannot decode
        raise ApiError(415, "UNSUPPORTED_IMAGE", "only jpeg, png, webp (and heic) images are accepted")
    raise ApiError(415, "UNSUPPORTED_IMAGE", "only jpeg, png, webp (and heic) images are accepted")''')
rep("from app.core.config import Settings\n", "from app.core.config import Settings\n")
rep("from app.recognize.pipeline import IndexNotReadyError, Recognizer\n",
    "from app.recognize.pipeline import IndexNotReadyError, Recognizer\nfrom app.vision.imaging import HEIC_BRANDS, heif_available\n")

# client key
rep('''def client_key(request: Request) -> str:
    """CF-Connecting-IP only counts when the TCP peer is loopback (our own tunnel); else the peer IP."""
    peer = request.client.host if request.client else "unknown"
''', '''def _clean_ip(value: str) -> str | None:
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None


def client_key(request: Request) -> str:
    """Rate-limit key.

    ``X-FDX-Client-IP`` (set by our Netlify function) is honoured ONLY when the request carried a
    valid bearer token (``auth`` sets ``request.state.bearer_ok``); anyone else could forge it.
    Otherwise CF-Connecting-IP counts only when the TCP peer is loopback (our own tunnel); else the peer IP.
    """
    peer = request.client.host if request.client else "unknown"
    if getattr(request.state, "bearer_ok", False):
        forwarded = _clean_ip(request.headers.get("x-fdx-client-ip", ""))
        if forwarded:
            return forwarded
''')
rep('''            if hmac.compare_digest(supplied.encode(), settings.token.encode()):
                return''', '''            if hmac.compare_digest(supplied.encode(), settings.token.encode()):
                request.state.bearer_ok = True
                return''')

# state / lifespan / handlers
rep('''    state: dict[str, object] = {"recognizer": recognizer, "error": None}
''', '''    state: dict[str, object] = {"recognizer": recognizer, "error": None, "warm": False, "last_ms": None,
                                "started": time.monotonic()}
''')
rep('''                state["error"] = f"{type(error).__name__}: {error}"
        yield''', '''                state["error"] = f"{type(error).__name__}: {error}"
        rec = state["recognizer"]
        if rec is not None:
            warm_up = getattr(rec, "warm_up", None)
            try:
                if warm_up is not None:
                    warm_up()
                state["warm"] = True
            except Exception as error:  # noqa: BLE001 - stay up, report warm=false
                logger.exception("warm-up failed")
                state["error"] = f"warm-up: {type(error).__name__}: {error}"
        state["started"] = time.monotonic()
        yield''')
rep('''    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "HTTP_ERROR", "message": str(exc.detail)}
        return JSONResponse({"error": detail}, status_code=exc.status_code, headers=exc.headers)
''', '''    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "HTTP_ERROR", "message": str(exc.detail)}
        return JSONResponse(error_body(detail["code"], detail["message"]), status_code=exc.status_code,
                            headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields = ", ".join(sorted({str(e["loc"][-1]) for e in exc.errors() if e.get("loc")})) or "request"
        return JSONResponse(error_body("INVALID_REQUEST", f"invalid or missing field: {fields}"), status_code=422)
''')

# health
old = s[s.index('    @app.get("/v1/health"'):s.index('    @app.get("/v1/index/manifest"')]
new = '''    @app.get("/v1/health", dependencies=[Depends(auth)])
    def health() -> dict:
        rec = current()
        index = rec.index if rec else None
        counts = ({lang: m["counts"]["cards"] for lang, m in index.manifests.items()}
                  if index is not None else {})
        catalog_versions = {m.get("catalogVersion") for m in index.manifests.values()} if index is not None else set()
        catalog_version = (next(iter(catalog_versions)) if len(catalog_versions) == 1 else
                           "|".join(f"{lang}:{m.get('catalogVersion')}" for lang, m in index.manifests.items())
                           ) if index is not None and catalog_versions else None
        warm = bool(state["warm"])
        # Ready = every configured language index loaded AND the model warmed with a dummy embed.
        ready = bool(index is not None and len(index) > 0 and set(settings.langs) <= set(counts) and warm)
        return {
            "status": "ok" if ready else "degraded",
            "ready": ready,
            "warm": warm,
            "counts": counts,
            "catalogVersion": catalog_version,
            "indexVersion": index.version if index is not None else None,
            "uptimeSec": round(time.monotonic() - float(state["started"]), 1),  # type: ignore[arg-type]
            "lastIdentifyMs": state["last_ms"],
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
            "heic": heif_available(),
            "index": {"ready": index is not None, "languages": list(counts), "counts": counts,
                      "total": sum(counts.values()),
                      "version": index.version if index is not None else None},
            "error": state["error"],
        }

'''
s = s.replace(old, new)

rep('raise ApiError(413, "IMAGE_TOO_LARGE", "image exceeds 8 MB")', 'raise ApiError(413, "PAYLOAD_TOO_LARGE", "image exceeds 8 MB")')
rep('raise ApiError(503, "BUSY", "recognizer is busy", {"Retry-After": "1"})',
    'raise ApiError(503, "RECOGNIZER_BUSY", "recognizer is busy", {"Retry-After": "1"})')
rep('''        # No PII: no IP, filename or image content is logged.''', '''        state["last_ms"] = round(result["timingMs"].get("total", 0.0), 1)
        # No PII: no IP, filename or image content is logged.''')
rep('SERVICE_VERSION = "0.1.0"', 'SERVICE_VERSION = "0.2.0"')
p.write_bytes(s.encode())
print("ok")
