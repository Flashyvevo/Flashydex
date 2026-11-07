# sonnet-m2-fix report — Sol review 10 (S10-01..S10-07)

Status: code and tests done and green. **Two live proofs from item 1 NOT done: the live :8900 service was not restarted** (blocker below), so it still runs the old auth code.

## Blocker (needs the director)
- PID 12676 (python, the :8900 listener) cannot be stopped without force. `taskkill /PID 12676` (no /F) returned "can only be terminated forcefully". `taskkill /F` and every `powershell.exe ...` invocation are blocked by the unattended-mode approval gate, so I did not try to route around it.
- To finish: `taskkill /F /PID 12676` (or `Stop-Process -Id 12676 -Force`), then `bash scripts/recognition/serve.sh`, then re-run the two proofs at the end of S10-01.
- Another python listener sits on 127.0.0.1:8901 (PID 3680, not mine, old code). Left alone.

## S10-01 (P1) bearer required; Origin never authorizes
- `services/recognition/app/api/app.py:245-266` (`auth`): a valid bearer authorizes. Without one, any request carrying a proxy header (cf-connecting-ip, x-forwarded-for, cf-ray, forwarded, x-fdx-client-ip) or from a non-loopback peer gets 401 UNAUTHORIZED + `WWW-Authenticate: Bearer`, whatever its Origin. Only a direct loopback call without proxy headers passes (dev/CLI). A disallowed Origin is still 403 there, and the navigate / Sec-Fetch-Site:none checks are kept. CORS headers are unchanged.
- The rule is independent of whether a token is configured, so a tokenless dev service behind a tunnel is also closed.
- Tests: `tests/test_security.py` (`test_auth_gate_matrix`, 23 rows; `test_tokenless_dev_service_still_rejects_proxied_requests`; `test_gate_applies_to_all_v1_but_not_liveness`; `test_valid_token_is_required_and_bad_token_is_401`). Covered: missing token + allowed Origin 401, + preview Origin 401, forged CF-Connecting-IP/X-Forwarded-For + Origin 401, valid bearer 200 (with/without Origin), direct loopback without token 200. Rate-limit/CORS/spool tests now send the bearer. Also updated `test_api.py::test_token_is_required_for_proxied_requests` and `test_m2.py::test_client_ip_header_is_ignored_or_rejected_without_bearer`.
- Red→green: after the `auth` change but before the test edits, 23 old Origin-blessing tests failed; after the rewrite the security/api/m2 suites pass (60).
- Live check of the NEW code on a throwaway instance (:8902, real token, now stopped), status lines only:
  - Origin + CF-Connecting-IP, no bearer: 401
  - preview Origin + X-Forwarded-For, no bearer: 401
  - X-Forwarded-For only: 401
  - bearer + Origin + CF-Connecting-IP: 200 (match swsh3-136)
  - wrong bearer: 401
  - direct, no headers: 200
- **Public tunnel proof not done.** Current live state (old code): public tunnel POST with only `Origin: https://flashydex.netlify.app` → **200** (still bypassable until restart). `https://flashydex.netlify.app/api/identify` for swsh3-136 → 200 (production function, still the old deployed version).

## S10-02 (P1) decision sees top-2 regardless of max_candidates
- `app/recognize/fusion.py:89-95` adds `DECISION_ROWS = 2`; `app/recognize/pipeline.py:165-169` ranks `max(max_candidates, 2)`, runs `decide`, then slices.
- New `tests/test_limit_invariance.py` (live index + model, skipped if absent): PIL top-78 % crop → 630x880 JPEG q85 of `base4-46` (must not be `match` for `base1-32`) and `lc-49` (must not be `match` for `base4-46`); status and confidence identical for limits 1/2/3/5; exact reference limit-independent; unit check of `rank`/`decide`.
- Red (old pipeline stashed): both crop tests and the DECISION_ROWS test failed. Green with the fix: 4 passed.
- Eval `python -m app.cli eval --lang en --n 50` (uses max_candidates=3), before vs after identical: top1 0.80, top3 0.84, match 18 / candidates 25 / no_match 7, matchPrecision 1.0, falseMatchRateOnRemoved 0.0, p50/p95 519/579 ms (before 517/610). No regression. This eval doesn't exercise limit 1; the new test does.

## S10-03 / S10-04 / S10-06 `netlify/functions/identify.ts` (rewritten, helpers exported)
- S10-03: `parseRetryAfter` (delay-seconds only, 0..86400); `mapUpstreamError` keeps it on 429/503; `bucketRetryAfter` computes one for the local 429.
- S10-04: 503 mapped by upstream code. `RECOGNIZER_BUSY`/`BUSY` → RECOGNIZER_BUSY 503; `INDEX_NOT_READY`, `MODEL_MISSING` → same code with HTTP 503, retryable. Anything else 503/5xx → RECOGNIZER_OFFLINE 502 (was BUSY). `client.ts:41-48` already maps those codes with status 503 to `index_unavailable` / `model_unavailable`; no client change.
- S10-06: `readCapped` counts streamed bytes up to 6 MiB total (cancels the stream beyond), `validateMultipart` parses only each part's headers and requires exactly one `image` part (else 400 INVALID_IMAGE). The body is buffered up to the 6 MiB cap, then forwarded as bytes (the `duplex` hack is gone).
- Tests: `netlify/tests/identify.test.ts`, run with `node --test netlify/tests/identify.test.ts` (Node 24 strips types): 23 pass. Covers no Content-Length, 6 MiB+ stream, boundary overhead, duplicate/missing image, a fake `name="image"` inside binary data, 429 and BUSY Retry-After, INDEX_NOT_READY/MODEL_MISSING, local bucket. Deviation: placed in `netlify/tests/`, not `netlify/functions/`, because Netlify deploys every file in `functions/` as a function and a test file would run on import. Written after the code, so no red run against the old function.

## S10-05 `apps/mobile/src/lib/recognition/prepare.ts`
- Removed `shouldSkipReencode`/`SKIP_REENCODE_BYTES` and the skip branch (~line 146). `prepareImage` always canvas-encodes (`reencoded: true`), still EXIF-upright via `<img>`. The director's iOS fixes (load event authoritative, tolerated `decode()` rejection, OffscreenCanvas→DOM canvas fallback) are untouched.
- `prepare.test.ts`: dropped the skip tests; added `prepareImage` tests with stubbed Image/canvas (small JPEG never returned unchanged, downscale to 1600, decode() rejection tolerated). `npx vitest run src/lib/recognition`: 50 pass.

## S10-07 docs
- `docs/RECOGNIZER-HOSTING.md`: says plainly the tunnel runs from a manually started `tunnel.ps1`, the FlashyDex-Tunnel supervisor exits immediately with unknown cause, auto start/restart is not delivered, and FlashyDex-Recognizer does hold :8900. Netlify quotas are labelled legacy/plan-dependent; the VPS claim is marked unmeasured. Function behavior and the bearer-only rule are described.
- `supervise.ps1` untouched: I couldn't prove a task start since PowerShell is blocked here. `schtasks` shows both tasks Ready, last result 0.

## Gates
- `bash scripts/test-recognition.sh`: 101 passed. `ruff check services/recognition`: clean.
- `npm run typecheck`: pass. `npm run lint`: 0 errors, 23 warnings.
- Mobile vitest `src/lib/recognition`: 50 pass. Function tests: 23 pass.
- :8900 left running (old code, PID 12676).

## Open risks
- Until the restart, the public tunnel stays Origin-bypassable. The new function code is also undeployed (no commit/push); Netlify auto-deploys on push to main.
- The function buffers up to 6 MiB per request in memory.
- Vite dev proxy is unchanged (strips Origin, calls loopback), so dev keeps working. Direct LAN-HTTPS-Origin calls to :8900 are now 401 by design.
