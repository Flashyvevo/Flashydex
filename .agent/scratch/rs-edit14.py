import pathlib

p = pathlib.Path("README.md")
s = p.read_bytes().decode().replace("\r\n", "\n")


def rep(old: str, new: str) -> None:
    global s
    assert old in s, old[:50]
    s = s.replace(old, new, 1)


rep('''Auth rule: token set → every `/v1/*` call needs `Authorization: Bearer *** (401 otherwise). Token unset → only
direct loopback callers are allowed; a request carrying proxy headers (`CF-Connecting-IP`, `X-Forwarded-For`, …)
is rejected, because a tunnel also connects from 127.0.0.1. `GET /health` (liveness) is always open.
Limits: 8 MB body (413), jpeg/png/webp only (HEIC → 415 `HEIC_UNSUPPORTED`), 60 requests/min/IP (429),
2 concurrent identifications (503 `BUSY`).''', '''Auth rule: a valid `Authorization: Bearer <token>` is accepted anywhere (401 `UNAUTHORIZED` when wrong). Without a
bearer, only allowlisted web origins or direct loopback callers get in; a request carrying proxy headers
(`CF-Connecting-IP`, `X-Forwarded-For`, `X-FDX-Client-IP`, …) and no allowed Origin is rejected (403), because a tunnel
also connects from 127.0.0.1. `GET /health` (liveness) is always open.
Per-IP limit key: `X-FDX-Client-IP` (set by the Netlify function) is honoured **only on bearer-authenticated
requests** (invalid IP text is ignored); otherwise `CF-Connecting-IP` from a loopback peer, else the TCP peer.
Limits: 8 MB body (413 `PAYLOAD_TOO_LARGE`), jpeg/png/webp/**heic** (HEIC via `pillow-heif`, magic `ftyp` + brand
heic/heix/mif1/msf1; anything else → 415 `UNSUPPORTED_IMAGE`), 30 requests/min and 300/day per IP + 600/hour global
(429 `RATE_LIMITED`), 2 concurrent identifications (503 `RECOGNIZER_BUSY`). Photos are decoded in memory and never
written to disk; logs carry status/size/timing only.''')
rep('''`candidates` (never preselect them); below 0.50 → `no_match` with no candidates. Errors: `{ "error": { "code", "message" } }`.
* `GET /v1/health` — index status/counts/model/embedder. `GET /v1/index/manifest` — per-language manifests.''',
    '''`candidates` (never preselect them); below 0.50 → `no_match` with no candidates (thresholds: see `/v1/health`
`thresholds`; calibration in `.agent/reports/sonnet-recog-service-report-m2.md`). OCR only ever *boosts* a candidate whose
collector number/total match what was read; "no digits read" and "misread digits" are neutral.

Errors, always `{ "error": { "code", "message", "retryable" } }` (HTTP status unchanged):

| code | HTTP | retryable |
|---|---|---|
| `PAYLOAD_TOO_LARGE` | 413 | no |
| `UNSUPPORTED_IMAGE` | 415 | no |
| `RECOGNIZER_BUSY` | 503 | yes (`Retry-After: 1`) |
| `RATE_LIMITED` | 429 | yes (`Retry-After`) |
| `UNAUTHORIZED` | 401 | no |
| `INDEX_NOT_READY`, `MODEL_MISSING` | 503 | yes |
| `INVALID_IMAGE`, `INVALID_LANG`, `INVALID_MAX_CANDIDATES` | 400 | no |
| `INVALID_REQUEST` (missing/bad multipart field) | 422 | no |
| `ORIGIN_NOT_ALLOWED` | 403 | no |

(`RECOGNIZER_OFFLINE` / `RECOGNIZER_TIMEOUT` are produced by the Netlify proxy, never by this service.)
* `GET /v1/health` — `{ ready, warm, counts: {en, ja}, catalogVersion, indexVersion, uptimeSec, lastIdentifyMs, … }`.
  `ready` is true only when every configured language index is loaded **and** the startup warm-up embed ran;
  `status` is `ok` iff `ready`. Also thresholds, limits, model/embedder, `ocr`, `heic`. `GET /v1/index/manifest` —
  per-language manifests.''')
rep('''`model fetch`, `identify <file> [--lang en|ja|any]`, `eval --lang en --n 200` (synthetic-photo eval incl. a
"card removed from catalogue" false-match test), `serve`.''', '''`model fetch`, `identify <file> [--lang en|ja|any]`, `eval --lang en --n 200` (synthetic-photo eval incl. a
"card removed from catalogue" false-match test), `serve`,
`index verify --catalog-db <catalog-en-….db> --catalog-db <catalog-ja-….db>` (every indexed id must exist in the
production catalog; prints counts, orphans, scannable cards not indexed; exit 1 on orphans),
`eval-m2 [--en 300 --ja 100 --seed 11 --transforms a,b --out data/logs/eval-m2.json]` (reference / rot90/180/270 /
±7° skew+perspective / blur σ1.5 / glare / JPEG q40 / 1600-px photo composite; resumable via `<out>.runs.jsonl`;
every run stores its top-5 candidates + raw signals so thresholds can be re-fitted offline with
`app.eval.simulate` / `summarise_m2`).''')
rep("collector number → weighted fusion with OCR as a soft boost →", "collector number → weighted fusion with OCR as a boost-only nudge →")
p.write_bytes(s.encode())
print("ok")
