# sonnet-scanner-ui-m2-2 report — DONE (all gates green)

`.agent/m2-ready-ui` touched.

## What changed, and why (product vs spec)
1. 375 flow test failure — SPEC was wrong (predecessor's earlier diagnosis held): `submitPhoto()` checked `isVisible()` before render. Fixed in `e2e/scanner-helpers.ts` (waits for either capture surface). Test passes at 375/390/430 now; `readOwnedCopies` and the Scan Another file-chooser step were fine.
2. BottomSheet Cancel under touch — PRODUCT bug. `components/overlay.tsx`: header `onPointerDown` now returns early when the target is inside a button/link/input, so no `setPointerCapture` retargeting. `e2e/scanner.spec.ts` now closes the confirm sheet three ways: `tap()` (touch), `click()` (mouse), Escape; the candidate sheet uses `tap()`.
3. Real service rejected the browser — PRODUCT bug (dev proxy). The service allows only allowlisted Origins or Origin-less loopback calls; the browser's `Origin: http://127.0.0.1:<port>` got 403 ORIGIN_NOT_ALLOWED (UI showed "Scanner offline"). `vite.config.ts`: both proxy entries strip the `origin` header. **The owner's :3200 dev server must be restarted to pick this up** (I did not touch it).
4. Real service returned `variantHints: {reverseHolo: null, …}`; the schema had `.optional()` only, so the client showed "Scanner gave an unexpected answer" on every real response — PRODUCT bug. `packages/schemas/src/recognition.ts`: hints are `.nullish()` (outside the "do not touch" list; one-word change, mirrors pydantic). `client.ts` `suggestVariant` accepts null; unit tests added for null hints.
5. `scanner-real.spec.ts`: `test.skip(!process.env.FLASHYDEX_E2E_REAL)` at file level (default `e2e/scanner` runs show "3 skipped"); UI test logs identify responses / failed requests. Fixture ids verified (below), no change needed.
6. `docs/UX.md`: appended "Milestone 2 — Scan screen".

## Playwright runs (mobile project, port 3207 — 3203 was held by another process)
- scanner.spec.ts (first run after overlay/helper fixes): `9 passed (1.7m)`
- `e2e/scanner` run A (after schema/proxy changes): `3 skipped` / `9 passed (1.7m)`
- `e2e/scanner` run B: `3 skipped` / `9 passed (1.7m)`
- (earlier, pre-schema-change) `e2e/scanner` run: `3 skipped` / `9 passed (1.7m)`
- routes.spec.ts: `1 passed (32.8s)`; core-flow.spec.ts: `2 passed (31.2s)` (also passed before schema change: 31.9s / 31.9s)
- scanner-real (first run, before fixes 3/4): `2 passed (2.5m)`, UI test `1 failed` (403, then bad_response); after fixes UI test alone: `1 passed (18.0s)`.
- Gates: typecheck clean; lint 0 errors, 23 warnings; `npm test --workspace=@flashydex/mobile`: 34 files, 457 tests passed.

## Measurements (MEASURE lines)
| viewport | /scan height after add | Take Photo | match art | candidate tiles | centre tab / label |
| --- | --- | --- | --- | --- | --- |
| 375 | 812 | 343x48 @16,136 | 260x363 | 3 stacked 343x525 at y156/693/1230 | 60x60 @157.5,736 / y798 |
| 390 | 844 | 358x48 | 260x363 | 2-up 173x308, 173x288 (x16/x201), third y476 | 60x60 @165,768 / y830 |
| 430 | 932 | 398x48 | 260x363 | 2-up 193x336, 193x316 (x16/x221), third y504 | 60x60 @185,856 / y918 |
scrollWidth ≤ innerWidth and all tap targets ≥ 44 px asserted at every state, passing. (Tile 2 is 20 px shorter than tile 1 in 2-up; cosmetic, tile 1 carries an extra line.)

## Real service (127.0.0.1:8900, index en 19659 / ja 3878)
Reference ids swsh3-19/20/136/33/84 all in `index/en/ids.json`; swsh3-19/20/136 verified in the dev catalog by the mocked flows (33, 84 only checked in the recognizer index; the real spec does not add them). Format: status@score.
| transform | 19 | 20 | 136 | 33 | 84 |
| --- | --- | --- | --- | --- | --- |
| reference | match (asserted, score not captured) | match 1.00 | match 1.00 | match 0.96 | match 0.96 |
| rot90 | match 1.00 | match 1.00 | match 1.00 | match 1.00 | match 0.94 |
| rot180 | match 1.00 | match 1.00 | match 1.00 | match 1.00 | match 0.92 |
| glare | match 1.00 | match 1.00 | match 1.00 | match 1.00 | match 0.81 |
| blur | candidates 0.65 | candidates 0.79 | match 0.91 | candidates 0.77 | match 0.82 |
| sleeve | candidates 0.78 | match 1.00 | match 1.00 | candidates 0.77 | match 0.86 |
Correct top-1 in 30/30; no wrong confident match. (Reference-19 score was cut from my log tail; the spec asserts match + correct id for every reference and passed.)
- unsupported: HTTP 415 `UNSUPPORTED_IMAGE` (API); in the UI an unreadable file fails client-side, never uploaded, "Try another photo" copy.
- offline (aborted request): "Scanner offline" + Try again. interrupted: Cancel returns to capture, no late result, exactly 1 request.
- UI real photo: swsh3-19 reference → match "Charizard V" 19/189, no overflow.

## Open risks
- Owner's :3200 dev server must restart for the proxy Origin fix; the same Origin allowlist applies to the production Netlify function (Terra's proxy should not forward the browser Origin, or the prod origin must be allowlisted).
- Real iPhone camera/HEIC/standalone behaviour unverified; real-photo accuracy only tested on generated transforms of reference art.
- Blur/sleeve of 19 and 33 land in `candidates` (0.65–0.78) — acceptable UX, not auto-selected.
- Port 3203 was occupied by a process I did not start; used 3207.
