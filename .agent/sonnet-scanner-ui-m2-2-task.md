# sonnet-scanner-ui-m2-2 — finish the Scan screen gates (continuation)

Unattended; never ask questions; no screenshots/images; report draft FIRST. Repo `C:/Projects/flashydex` (start every shell with `cd C:/Projects/flashydex`). No commits, no `npm install`. Dev server :3200 is the owner's (never start/kill). Playwright: `cd apps/mobile && FLASHYDEX_E2E_PORT=3203 npx playwright test <spec> --project=mobile --reporter=line`. Recognition service live on 127.0.0.1:8900 (token-gated upstream; the dev proxy reaches it without a token on loopback).

## Read first
`.agent/reports/sonnet-scanner-ui-m2-report.md` (your predecessor: what exists, what failed, "To finish"), `.agent/m2-contract.md` (UI section + error table), `.agent/sonnet-scanner-ui-m2-task.md` (original brief; the deliverables there still stand).

## Ownership
Everything the original brief listed PLUS `apps/mobile/src/components/overlay.tsx` (only for the BottomSheet Cancel-under-touch bug: the header's `setPointerCapture` on pointerdown swallows the button click under touch emulation — fix so Cancel/Close work with touch AND mouse AND Escape; add a unit/e2e assertion), and `apps/mobile/e2e/helpers.ts` (additive). Nothing in `src/platform/**`, `packages/core/**`, other routes.

## Do
1. Diagnose and fix the failing 375 flow test (`confirm → add → "Added to collection" → Scan Another → second add → reload → both copies persist`). Suspects from the report: `readOwnedCopies` before scanning (export download timing), the Scan Another file-chooser step (use `page.waitForEvent('filechooser')` + `setFiles`, or set the file via `setInputFiles` on the hidden input after Scan Another re-arms it), and the overlay Cancel bug. Fix the product if the product is wrong; fix the spec if the spec is wrong; say which.
2. Make the mocked suite green: `e2e/scanner.spec.ts` at 375/390/430 — then run it TWICE, plus `e2e/routes.spec.ts` and `e2e/core-flow.spec.ts` once each (both must still pass with the new Scan tab/route). Collect the 390/430 MEASURE lines (tile rects, /scan height, scrollWidth ≤ innerWidth, tap targets ≥ 44 px) into the report.
3. Run `e2e/scanner-real.spec.ts` once against the real service (`/api/recognizer/health` ok): first verify the five reference ids exist in the index (`curl -s http://127.0.0.1:8900/v1/health` + `services/recognition/data/index/en/ids.json`) and in the dev catalog (`apps/mobile/public/dev-packs/catalog-manifest.json` is the small swsh3 pack — swsh3 ids are fine); fix the fixture ids if not. Paste per-fixture results (reference, rot90, rot180, glare, blur, sleeve, unsupported, offline, interrupted). The service allows 30/min: keep the pacing; mark the spec `@real` and make sure `npx playwright test e2e/scanner` does NOT pick it up by default (use a `test.skip(!process.env.FLASHYDEX_E2E_REAL)` guard).
4. Append the scanner section to `docs/UX.md` (route, states, copy, measurements, iOS caveats from `.agent/research/ios-camera.md`).
5. Gates: `npm run typecheck`, `npm run lint` (0 errors), `npm test --workspace=@flashydex/mobile`, the Playwright runs above. Then `touch .agent/m2-ready-ui`.

## Report
`.agent/reports/sonnet-scanner-ui-m2-2-report.md`: what you changed and why (product vs spec), verbatim summary lines of every Playwright run, measurements table, real-service results table, open risks.
