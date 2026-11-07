# sol-review-10 — Milestone 2 scanner MVP

## Verdict: MVP ship-ready for beta — yes-after-P1s

The integrated scanner works through the LIVE Netlify PWA, not just curl: in an isolated review browser I installed both production catalogs, recognized EN Furret and JA ザシアンV, confirmed each through the existing sheet, used Scan Another, and read both copies back after full page reloads. However, two reproducible P1s prevent an unconditional beta approval: an arbitrary caller bypasses tunnel authentication by supplying an allowed Origin without a bearer, and `max_candidates=1` removes the runner-up before the confidence decision, producing wrong-printing `match` responses, including through the live function. Fix and independently retest those P1s before opening the beta. This is not physical-iPhone sign-off or real-phone-photo calibration. No demonstrated new collection data-loss path was found; storage/core files are unchanged against the specified baseline.

## Scope and provenance

- Reviewed HEAD `53256f2b3b066820f5c6eb0612e40d40cf30ac71`, branch `main`; checked status and the requested diff against `ef1f0ae` twice. Pre-existing director/scratch/untracked work was left alone.
- Read the binding M2 contract, owner specification, recognition design, hosting documentation, all four requested builder reports, Sol-9, requested implementation files, relevant tests, and the three requested component diffs.
- Only authored repository file: this report. No implementation edits, commit, push, configuration changes, service/task restart, server start or kill. Tests/builds used ordinary generated caches and scratch outputs. Browser-only test records belong to the named `sol-review-10` profile, not the owner's collection.
- Live browser: Windows HeadlessChrome/145, secure HTTPS, real SQLite worker/OPFS path; not Safari, an installed iPhone PWA, or native Capacitor. Local Playwright used the already-running HTTPS :3200 through `FLASHYDEX_E2E_BASE_URL`, so it did not start the suggested :3209 server.
- The bearer was read silently for a prefix comparison and authenticated probes; its value never appeared in output. Verified ignored by Git and raw 64-hex format. Never passed it into browser JavaScript.
- Builder measurements are not relabeled as my own. The 14 adversarial cases and live checks below are independently executed. They are not a representative accuracy benchmark.

## Findings

| ID | Severity | File:line | What | Why | Fix |
|---|---|---|---|---|---|
| S10-01 | P1 | `services/recognition/app/api/app.py:245–265`; `tests/test_security.py:39–48`; `tests/test_m2.py:141–150` | Missing bearer falls through to Origin authorization, even with a configured token and tunnel/proxy headers. Live tunnel GET health and POST identify both returned 200 with only `Origin: https://flashydex.netlify.app`; identify returned a real match. No-origin and IP-only probes returned 403; invalid bearer returned 401. | CORS/Origin is still authentication. Any non-browser client can forge Origin and bypass the function and its controls. A wrong token being rejected does not make an absent token safe. Existing tests explicitly bless the bypass. | Require valid bearer on tunneled/nonlocal `/v1/*` requests regardless of Origin. Retain only the narrow direct-loopback/no-proxy DEV exception. Keep CORS as browser policy, not authorization. Replace permissive tests with missing-token + forged-Origin/preview-Origin rejection cases. |
| S10-02 | P1 | `services/recognition/app/recognize/pipeline.py:164–166`; `app/recognize/fusion.py:109–116` | Output limit controls the confidence evidence. `rank(..., max_candidates)` truncates to one before `decide`, which substitutes runner score 0. A top-78% crop of `base4-46` returned wrong `base1-32` as `match`, 0.9042, through LIVE `/api/identify` with `max_candidates=1`. The same image with 3 returned candidates. Cropped `lc-49` likewise falsely matched `base4-46`, 0.9018. | The documented 1..5 API parameter defeats the ambiguity/margin safety rule. Current PWA requests 3, so these are not claims of default-PWA auto-selection, but the public API confidently asserts wrong printings. | Rank at least two eligible rows for the decision independently of the response limit, then slice the response. Test identical status/confidence for limits 1/2/3/5 on ambiguous reprints and both reproduced crops. |
| S10-03 | P2 | `netlify/functions/identify.ts:9–13,67–79,94–96` | Proxy drops upstream `Retry-After` on 429 and BUSY 503; its own bucket also emits 429 without it. | Service supplied 58 seconds for the bounded minute burst and 1 second for concurrent BUSY. The client understands Retry-After, but production proxy responses lose it and can say “a few seconds” for a much longer daily wait. | Preserve a validated Retry-After on mapped responses and calculate one for the local bucket; test mapping through the function, not only mocked client headers. |
| S10-04 | P2 | `netlify/functions/identify.ts:71–73`; `apps/mobile/src/lib/recognition/client.ts:41–43` | Every upstream 503 becomes RECOGNIZER_BUSY, including MODEL_MISSING and INDEX_NOT_READY. | The app has distinct unavailable/warming messages, but these never survive the production proxy. A missing model is misrepresented as transient load. Source-proven; I did not take down the model/index to manufacture a live outage. | Inspect the upstream error envelope and preserve/map its reason; reserve BUSY for actual concurrency rejection. Add proxy tests for model/index/BUSY cases. |
| S10-05 | P2 | `apps/mobile/src/lib/recognition/prepare.ts:64–66,132–134`; `prepare.test.ts:39–52` | Small upright JPEGs are uploaded unchanged, contrary to the binding always-reencode instruction. | Original EXIF/GPS/device metadata can travel with the image. Own live JPEG scan showed original/upload bytes both 133960. This proves the unchanged branch, not that this fixture contained GPS. Server non-retention does not strip metadata before transit. | Always canvas-reencode as contracted, or implement an explicit, tested metadata-stripping fast path. Keep EXIF-upright pixels. |
| S10-06 | P2 | `netlify/functions/identify.ts:87–104` | Function's 6 MiB guard checks declared Content-Length only; it neither counts streamed bytes nor validates exactly one image part. | Current Netlify edge cap protects this deployment, but the function does not independently implement the contract it claims. `multipart/form-data` prefix is not multipart validation. No live edge-cap bypass is claimed. | Bound actual bytes and validate the multipart shape, or explicitly amend the contract to rely on the measured platform cap and upstream validation. Test absent Content-Length, duplicate/missing image parts, and boundary overhead. |
| S10-07 | P2 | `docs/RECOGNIZER-HOSTING.md:56–69`; `scripts/recognition/supervise.ps1:27–35` | Operational docs describe working automatic tunnel startup/restart, but the supplied current state is manual `tunnel.ps1` because the tunnel supervisor does not launch it. The “current free-tier” allowance mixes legacy pricing into general guidance. | Readers may expect logon recovery that has not been delivered. Repeated supervisor child exits are visible; enabled/Ready task status is not a tunnel-health test. Costs depend on the actual legacy/credit-based plan. | Document the manual dependency now; fix and prove task-to-tunnel restart/republish later without conflating registration with operation. Label legacy quotas and link current plan billing; do not promise a $5–10 VPS meets the recognizer's resource/latency needs without measurement. |

No P0 found. S10-03 through S10-07 are bounded contract/UX/operations issues, not demonstrated collection corruption. Remaining Sol-9 storage proof qualifications are not closed merely by adding the scanner.

## Secrets, authentication, limits, privacy

### Bundle and normal topology

- Independently ran `cd apps/mobile && npx vite build --outDir C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/sol-review-10-build` successfully, including the service worker build.
- Expanded and checked **63 existing `assets/*.js` files**. `grep -Fql` of the actual token's first 12 characters returned **1 (absent)**; `trycloudflare` returned **1 (absent)**. Raw token-format check passed. Neither comparison printed its search pattern.
- An earlier `$TMPDIR` build used an unsuitable native path; its grep encountered missing assets. Those initial “absent” labels are INVALID evidence and excluded. The explicit-path build/checked globs above replace them.
- Browser client uses only `/api/identify` and `/api/recognizer/health`, no Authorization and no discovery. Unit tests assert that shape; mocked Playwright verifies the missing Authorization header. API rewrites precede SPA fallback. The function injects the bearer and forwards platform client IP, not browser-supplied X-FDX-Client-IP.
- Functions contain no console/logger calls and do not echo errors, auth headers, upstream URL, or token into responses. Token/discovery handling is server-side. Vite's broad `FLASHYDEX_` envPrefix is a reason to retain functions-only secret scope, not evidence that today's bundle leaked it.
- The discovery JSON is publicly readable and CORS-accessible; tunnel-address obscurity is not a security boundary. Normal browser architecture is correct; “the function is the only caller” is disproved by S10-01.

### Actual auth probes

| Tunnel request | Observed |
|---|---|
| `/v1/health`, no bearer or Origin | 403 ORIGIN_NOT_ALLOWED |
| Same + spoofed X-FDX-Client-IP, no bearer | 403 |
| Same + invalid bearer | 401 UNAUTHORIZED + WWW-Authenticate |
| Same + allowed Origin only | 200, ready/warm true |
| Same + allowed Origin and spoofed X-FDX-Client-IP, no bearer | 200; admission bypass, not proof that the spoofed IP was trusted |
| POST identify, allowed Origin only, cached Furret reference | 200 match, correct swsh3-136 |

`client_key` honors X-FDX-Client-IP only after `request.state.bearer_ok`; otherwise it falls back to trusted-loopback CF IP/peer. Independently passing service tests exercise changed forwarded identities with/without a valid bearer. That trust rule is sound in the inspected implementation even though Origin admits an unauthorized request.

### Actual size/rate/concurrency probes

- Live **7 MiB actual body** sent from the browser to `/api/identify`: **413**, empty body, `Cache-Control: private,max-age=0` from the platform. This is an edge response, not the function's JSON/no-store helper. Client maps raw HTTP 413 even without JSON.
- Direct service declared 9 MiB body: **413 PAYLOAD_TOO_LARGE**, “image exceeds 8 MB.” Passing service tests also exercise oversized image and counted/chunked bodies without Content-Length (`BodyLimitMiddleware` has 64 KiB multipart overhead allowance; image-read limit is 8 MiB).
- A fake overdeclared edge Content-Length probe timed out after HTTP 100; it is NOT counted as size-limit proof. A browser-to-DEV-proxy 9 MiB attempt did not produce a collected response; excluded. The actual 7 MiB live body, direct declared guard, and executed streamed-body tests are the retained evidence.
- Bounded minute burst: **31 requests**, using the tiny committed unsupported-file fixture against loopback. Requests 1–30 returned 415 after rate accounting; request 31 returned **429, Retry-After: 58**. Stopped that burst immediately. Curl's `/dev/null` sink produced local write errors on this Windows environment; response headers/statuses were still received, so no body-content claim is made from that burst.
- Separate **4 simultaneous authenticated** local photo requests, using one forwarded test identity: **2 returned 200; 2 returned 503 RECOGNIZER_BUSY, Retry-After: 1**. The intentional load probes therefore used 35 requests, below the requested 40 ceiling; no sustained load test.
- Live health reports 30/minute, 300/day, 600/global-hour, 2 concurrent, 8388608 upload bytes. **I did not exhaust the live 300/day budget**: doing so would violate the bounded-request constraint. Executed daily-window tests use an injected monotonic time and reduced daily limit (5), not a live 300-request proof. Default-300 exhaustion is an explicit coverage gap, not a measured pass.
- Function bucket is best-effort, per-instance, capacity 12/refill per minute, not distributed abuse protection. Upstream controls are the real boundary. This review did not prove resistance to distributed IP abuse or instance/process restarts.

### Privacy

- `bash scripts/test-recognition.sh` passed the real-pipeline no-write/log-clean test in `tests/test_m2.py:272–307` and the upload-spool/no-rollover test in `tests/test_security.py:184–225`; no skips were reported.
- These compare data-directory snapshots and reject logged filenames/image signatures; the spool test monitors rollover and temporary image-sized files. Successful-path photos stay in memory. This is not a forensic disk audit of all provider infrastructure.
- Inspected the actual listener's `data/logs/serve-director2.log`: identify lines contain status, numeric byte count, language and elapsed milliseconds, not uploaded filenames, raw bytes, or exact client paths. `app.cli` disables Uvicorn access logs. Numeric byte length is not image content.
- Both function response helpers set no-store, confirmed on live health and successful identify. Platform-generated oversize rejection differs as documented above.
- No scanner analytics transport found. `timing.ts` stores counters/timings/status in memory/sessionStorage and performance entries, not photos. Blob preview URLs are revoked. S10-05 is the separate metadata-in-transit qualification.

## False-confidence results — independent API execution

Cached references came from `services/recognition/data/cache/images/**`; transformed scanner JPEGs came from the committed E2E fixtures. Additional crops/composites were made in browser canvases in memory, JPEG quality 0.85. Unless stated otherwise, max_candidates=3. The JA source was visually checked as Japanese ザシアンV, 225/172; the non-card control was visually checked as a golden retriever holding a flower.

| Input / truth | Status | Confidence | Returned top card(s) | Assessment |
|---|---|---:|---|---|
| EN base4-46 Kadabra reference | candidates | 1.0000 | base4-46; lc-49 0.9765; base1-32 0.9331 | Safe ambiguity despite top score 100%. |
| EN lc-49 Kadabra reprint reference | candidates | 1.0000 | lc-49; base4-46 0.9765; base1-32 0.9229 | Safe same-art printing ambiguity. |
| base4-46 reference, max=1 | match | 1.0000 | base4-46 | Correct ID, but status changes solely from response limit. |
| Furret swsh3-136 art-only heavy crop: source rectangle x15,y34,w215,h150 stretched to 630x880 | candidates | 0.7368 | swsh3-136 | Safe, no invented confident match. |
| Blank white 630x880 JPEG | no_card | 0 | none | Safe. |
| Two-card screenshot: 1300x950 gray canvas; 630x880 Furret at (10,35), Charizard V at (660,35) | candidates | 0.6120 | dpp-DP45; swsh6-28; swshp-SWSH278 | Wrong suggestions, not wrong `match`; acceptable conservative status. |
| JA S12a-225 with lang=en | candidates | 0.5579 | EN swsh7-212; 30th-060; swshp-SWSH007 | Wrong-language suggestions, not match. Independently repeated through LIVE function. |
| Same JA source with lang=any | match | 1.0000 | JA S12a-225 | Correct control. |
| TCG Pocket A1-001 Bulbasaur, excluded from physical index | candidates | 0.7055 | swsh10.5-001; me02.5-005; sv10.5w-002 | Safe out-of-index refusal to assert a match. |
| Non-card dog photograph | no_match | 0.0226 | none | Safe. Source: `https://images.unsplash.com/photo-1552053831-71594a27632d?w=600`. |
| lc-49 top 78% of image, resized to 630x880 | candidates | 0.9018 | base4-46; lc-49 0.8976; base1-32 0.8755 | Wrong top-1 but safely ambiguous. |
| Identical lc-49 crop, max=1 | **match** | **0.9018** | **base4-46, WRONG PRINTING** | **P1 S10-02.** |
| base4-46 top 78% of image, resized to 630x880 | candidates | 0.9042 | base1-32; base4-46 0.8971; lc-49 0.8772 | Wrong top-1 but safely ambiguous. |
| Identical base4-46 crop, max=1 | **match** | **0.9042** | **base1-32, WRONG PRINTING** | **P1 S10-02; independently reproduced LIVE, HTTP 200/no-store.** |

- Saved/aggregated 14 distinct cases in code: 8 candidates, 4 match, 1 no_card, 1 no_match. Two match responses are wrong printings; both use max=1. No wrong default-max=3 match was observed in this small set.
- These are actual API responses, not offline threshold simulation. The API's limit=1 is documented/accepted; it is not malformed input.
- Same-art reprints were exercised. Physical reverse-holo/promo twins and real phone glare/foiling are **not proven** by a reference image. Furret offers normal/reverse choices; recognition did not silently add either. Variant guesses remain hints, catalog-filtered by the existing sheet, and require confirmation.
- Reproduce the P1 from cached `en/base4-46.webp`: retain full width and the top `floor(height * 0.78)` pixels, draw into 630x880, encode JPEG q0.85; POST image + lang=en + max_candidates=1. Compare the same bytes with max_candidates=3. Do the same with `en/lc-49.webp` for the second wrong printing.
- Across these deliberately mixed 14 cases, observed server total-ms mean/p50/p95 = **818.4 / 689.1 / 1680.2**, range **88.9–2016.5**; calculated from saved rows with linear-interpolated percentiles. Not an idle/phone/photo accuracy benchmark. Live wrong-language curl later took 4807.9 server ms under different conditions; live wrong-printing crop took 590.6 ms.
- No owner-phone held-out calibration set was collected. Builder's partial synthetic eval and disabled OCR disagreement penalty do not establish ≥99% real-photo match precision. Do not lower thresholds on the strength of these examples.

## Storage, actual live workflow, and index integrity

- `git diff --stat ef1f0ae -- apps/mobile/src/platform packages/core` and subsequent name-only check returned **empty**. Scanner integration does not modify the storage adapter, ownership/handoff machinery or core services.
- Add chain traced: `scan-flow.tsx:79–90` → existing `AddConfirmSheet` → existing `useAddCopies` (`data/collection-hooks.ts:38–50`) → `services.collection.add/bulkAdd`, retry:false. `onAdded` is after the awaited existing mutation, not a second write. Undo likewise uses the existing remove mutation. No new SQL/user-DB persistence path found.
- `AddConfirmSheet` diff is additive: variant hint filtered against actual catalog variants and an after-add callback. Language/card target remains composite. Overlay diff only excludes interactive header targets from drag capture; shell diff replaces the coming-soon sheet with Scan links.
- Own local scanner suite executed the committed three-add/reload assertion at 375/390/430: duplicate Charizard V becomes ×2, Furret remains one, exported owned-copy count is 3, two collection tiles survive reload. Cancel/tap/mouse/Escape and non-auto-selected candidate branches also executed successfully in the complete rerun.
- Own LIVE production profile installed **both EN and JA v2026.10.31.003**. Settings readback showed both Downloaded; subsequent live manual Furret search returned EN and JA results. Browser estimate after install: **185925327 bytes total origin usage**, including **177429642 fileSystem bytes**. This is origin usage, not pure catalog DB size or heap.
- Actual LIVE `/scan`: committed Furret JPEG → match swsh3-136 → Confirm & Add → existing sheet → Added. Scan Another kept `/scan` mounted, then a cached JA WebP was reencoded and recognized as S12a-225 → same sheet → Added. Two collection tiles, **2 copies / 2 unique**, survived repeated full navigations/reloads; final readback still contained both languages.
- Visible-tab JA scan measured prepare **20.9 ms**, upload-to-response **942.3 ms**, network **943.0 ms**, server **440.7 ms**, total **964.3 ms**; original/upload **31382/38713 bytes**, 245x337. Reference/fixture input, not a physical iPhone photo. The first live EN scan had **48715.1 ms preparing while the review tab was hidden** and completed after bringing it visible; exclude that background-tab artifact from ordinary performance claims, but do not claim it was fast.
- Early review browser opens showed INIT_FAILED; an intentional duplicate own tab also produced the expected writer-lock screen. After closing that duplicate and allowing visible startup/reload, live storage opened and all above installs/adds/reloads succeeded. No wipe/recovery hack was used. Cause of the early INIT_FAILED was not established; not presented as a new scanner data-loss defect or hidden from this report.
- JA card artwork failed to load from the CDN in the live UI; the existing named/numbered image fallback was visible and did not prevent correct selection/add. Cached recognition image was available. This is not proof that every candidate has working remote art.
- Live offline fallback was independently exercised by **browser-only simulated rejection** of the two scanner API fetches, without stopping the service/tunnel: offline banner appeared, Search Manually returned actual installed Furret results (including “You own 1”), Browse by Set reached `/sets` and showed the collected EN and JA sets. Removed the injection, reloaded, and read healthy API status back. This was not a real provider outage test.
- Independently ran read-only `app.cli index verify` against both `.003` production DBs: EN indexed/unique **19659/19659**, JA **3878/3878**, **0 orphans** in each. Index catalog version is `.001`, not `.003`; scannable missing counts are **7 EN / 4 JA**. Pocket exclusion is intentional. Missing physical references and limited JA coverage remain capability gaps, not unknown IDs being committed to the collection.
- Sol-9 remains the storage baseline; these scanner checks do not upgrade its partial W01–W14/atomic-proof evidence or prove Safari eviction, backup, migration-kill or physical power-loss behavior.

## Gates run by this review

| Command / run | Actual result |
|---|---|
| `npm run typecheck` | Exit 0, core/schemas/mobile checked. |
| `npm run lint` | Exit 0; **0 errors, 23 warnings**. |
| `npm run test --workspace=@flashydex/core`, first run | Exit 1; **379 passed, 1 failed** / 34 files. Existing contains-search perf assertion: p95 **311.3 ms** vs 300 ms while other gates ran. Not a scanner/core code change. |
| Same core command, rerun | Exit 0; **34 files, 380 tests passed**, 89.08 s. Do not erase the first failure or claim an uninterrupted green gate. |
| `npm run test --workspace=@flashydex/mobile` | Exit 0; **34 files, 457 tests passed**, 69.34 s. |
| `bash scripts/test-recognition.sh` | Exit 0; **92 passed**, 53.87 s; real pipeline/privacy tests ran, no reported skips. |
| Scratch `npx vite build --outDir <explicit scratch path>` | Exit 0; app + SW built; secret/tunnel scans valid as described above. Large-chunk warning remains. |
| `FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 FLASHYDEX_E2E_PORT=3209 npx playwright test e2e/scanner.spec.ts --project=mobile --workers=1 --output=<scratch>` | First full run: **8 passed / 1 failed**, 3.6m. Failed before scanner assertions waiting 120s for “English catalog ready” during onboarding; dashboard still showed catalog absent. |
| Targeted repeat of the three landing/result/error tests | **3 passed**, 1.1m, including the original 375 case. |
| Complete scanner suite rerun, same external server | Exit 0; **9 passed**, 1.5m. All three repeated-add/reload flows passed. |
| `app.cli index verify --catalog-db <en .003> --catalog-db <ja .003>` from service directory | Exit 0, ok:true, counts/orphans above. Initial root-directory invocation could not import app; corrected cwd, no install/workaround. |

The initial full scanner-suite onboarding failure resembles the builder's earlier intermittent install wait; its cause was not established here. The passing rerun is real, but does not justify deleting that failure from release evidence. No service/router files were edited to make tests pass.

## Availability, uptime and costs

- Live function health returned ok:true with EN 19659 / JA 3878; service health returned ready:true, warm:true, v0.2.0, model `onnx-community/dinov2-small`, HEIC available. Listener independently checked at **127.0.0.1:8900, PID 12676**, not a public :8900 bind.
- Per supplied director state, **FlashyDex-Recognizer owns :8900**; I did not restart it or independently retrace its entire process ancestry. Both scheduled-task registrations are enabled and report Ready, which is compatible with a detached WScript launcher and does not itself prove supervision.
- **FlashyDex-Tunnel's supervisor does not launch the tunnel; director runs `tunnel.ps1` manually.** The live quick tunnel currently works, and discovery matches local recognizer.json. Supervisor log inspection includes repeated short child exits/retry backoff. No logon/crash recovery success is claimed.
- Hosting docs honestly disclose owner-PC/network dependency, random rotating hostname, no quick-tunnel SLA, potential rate limiting, metered functions, and the named-tunnel/domain upgrade. Those are appropriate beta limitations, not production uptime guarantees.
- S10-07 qualifies their automatic-recovery and pricing wording. Official current documentation distinguishes credit-based plans (Free 300 credits/month; compute billing) from legacy plans (125k function invocations). Actual account billing classification/spend was not audited; the builder's Pro-plan claim is not a fresh billing audit by this reviewer.
- Official function defaults are **60 seconds synchronous**, **6 MB buffered request payload**, with binary/base64 overhead reducing effective binary capacity. Thus 20-second upstream abort is below the published synchronous ceiling; 12-second client timeout is intentionally shorter. I did not induce a real 20-second upstream stall. Discovery has its separate 5-second timeout.
- Sources checked: https://docs.netlify.com/build/functions/configuration ; https://docs.netlify.com/build/functions/usage-and-billing/ ; https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans ; https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-legacy-plans/legacy-pricing-plans .

## Owner definition-of-done checklist

The owner document actually numbers **12** steps, not 10 (`docs/MILESTONE-2-SCANNER.md:673–688`). The first ten form the capture/add loop; retaining 11/12 below avoids silently dropping persistence and offline fallback. “Automated/live” means this review's browser/fixtures unless explicitly identified as mocked. Every physical-device conclusion remains separate.

| Step | Evidence / status |
|---|---|
| 1. Open Add | Binding contract changes the scanner entry to **Scan → /scan**; verified live. `/add` remains manual and worked with both catalogs. `[needs owner iPhone]` discoverability/installed-app navigation. |
| 2. Take Photo or Choose Photo | Committed tests verify capture=environment vs no capture and accept list; live Choose Photo input accepted a real image file. `[needs owner iPhone]` actual camera/photo-library handoff and picker cancellation. |
| 3. Photograph a real Pokémon card | **Not proven by fixtures/reference art.** `[needs owner iPhone]` physical card, ordinary lighting, sleeves, reverse/promo ambiguity. |
| 4. Send optimized photo | Live JA WebP → JPEG byte/size/timing readback; resize/EXIF branches inspected/tested. Small-JPEG metadata exception S10-05. `[needs owner iPhone]` actual HEIC/HDR/P3/EXIF orientation and memory behavior. |
| 5. Return exact card or sensible candidates | Live EN/JA matches, 14 independent adversarial cases, mocked candidate layout at 375/390/430. **S10-02 blocks confidence approval**; real-photo precision uncalibrated. `[needs owner iPhone]` physical-photo accuracy. |
| 6. Confirm card | Explicit Confirm & Add on live EN and JA; candidate selection never auto-adds. `[needs owner iPhone]` touch/VoiceOver confirmation. |
| 7. Existing confirmation sheet | Same sheet opened live, variant/condition/quantity/optional fields retained; touch/mouse/Escape regressions tested locally. `[needs owner iPhone]` Safari sheet interactions. |
| 8. Add it | Live two-language adds used existing mutation; local three-add/duplicate tests passed. `[needs owner iPhone]` physical-device commit feedback. |
| 9. Appears in collection | Live two copies / two unique, EN and JA tiles, verified again after reload. `[needs owner iPhone]` collection readback in the owner's chosen Safari/Home Screen storage container. |
| 10. Immediately scan another | Live Scan Another → second JA recognition/add, stayed on `/scan`; Playwright observes filechooser and repeated add at all widths. `[needs owner iPhone]` synchronous user-gesture camera reopening. |
| 11. Reload preserves collection | Repeated LIVE full navigations retained both copies and both production catalogs; committed duplicate/export assertion passed locally. `[needs owner iPhone]` close/reopen, standalone lifecycle, storage grants/eviction/backup. |
| 12. Manual search/browse while scanner offline | Local mocked suite passed; live browser-only API-failure injection preserved real bilingual search and set browsing; restored API and checked healthy final state. `[needs owner iPhone]` actual PC/tunnel outage and installed-PWA offline assets. |

Full milestone completion still requires the owner's actual iPhone photographed-card → correct result → confirm/add → scan another → reload demonstration. Beta approval after P1 fixes is not permission to label that unperformed device test complete.

## Evidence locations and handoff

- Scratch build: `C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/sol-review-10-build`.
- Playwright outputs: same scratch root, `sol-review-10-playwright`, `sol-review-10-playwright-repeat`, `sol-review-10-playwright-full-repeat`.
- Browser evidence directory: `C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/browser-use/workspace/local-475129670d708d55eec5f0a2256d944ce521de7e3a8a189cad7d7e468fca1f3b/` — `sol-review-10-results.json` (14 cases), `sol-review-10-live-results.json` (live wrong-printing/edge cap), `sol-review-10-live-storage.json`, `sol-review-10-live-fallback.json`, `sol-review-10-final-readback.json`.
- Removed browser-only offline and worker-observation injections, reloaded the live collection, and read healthy recognizer status back. Service, tunnel and existing dev server were left running untouched.
- Next fix review must independently repeat forged-Origin rejection and limit-invariant confidence/cropped-printing probes. Owner-only remainder: physical iPhone/PWA/camera/HEIC/real-photo calibration; do not send code-fix work back to the owner as a substitute for those P1 repairs.
