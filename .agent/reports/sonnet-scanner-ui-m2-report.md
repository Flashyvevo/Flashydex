# sonnet-scanner-ui-m2 report — INCOMPLETE (run budget exhausted)

`.agent/m2-ready-ui` was NOT touched: the mocked suite is not green. Gates were not run twice. The real-service spec was never run. The docs/UX.md appendix was not written.

## Done
- Moved the parked wip into src/lib/recognition/{client,copy,prepare,timing}.ts (+ tests), src/components/scanner/scan-flow.tsx, src/data/recognition.ts. .agent/wip-scanner deleted. resolve.ts (URL discovery) dropped.
- client: same-origin POST /api/identify, no Authorization, no URL discovery, 12 s timeout + AbortController. Maps contract codes (PAYLOAD_TOO_LARGE, UNSUPPORTED_IMAGE, RECOGNIZER_BUSY, RATE_LIMITED, RECOGNIZER_OFFLINE, RECOGNIZER_TIMEOUT, UNAUTHORIZED -> offline) and the raw service codes. Busy is no longer auto-retried.
- prepare: <img> decode only (no createImageBitmap), canvas resize to 1600, JPEG q0.85, magic-byte sniff. HEIC that fails to decode shows "Choose a JPEG, or switch Camera -> Formats -> Most Compatible".
- vite.config.ts: dev proxy /api/identify -> :8900/v1/identify, /api/recognizer/health -> :8900/v1/health.
- shell.tsx: center tab is a Scan link to /scan (tab-scan, aria-label "Scan a card", lime); sidebar entry added; ScanSheet deleted.
- routes/_modal/scan.tsx: four actions (scan-take with capture=environment, scan-choose, scan-search, scan-browse); both inputs accept="image/jpeg,image/png,image/webp"; one-shot 3 s health check -> non-blocking "Scanner offline" banner.
- scan-flow.tsx: preparing -> analyzing (Cancel) -> match / candidates (1 col at 375, 2 col >=390) / no_match / no_card / failed. Catalog-not-installed -> install prompt. Card-not-in-catalog -> "check for a newer catalog in Settings" + Search Manually. Every failure offers Try Another Photo / Search Manually / Browse by Set (+ Try again when retryable). After add: "Added to collection" with Scan Another (scan-another, re-opens the Take Photo input, stays on /scan), View Card, Undo.
- add-confirm.tsx (additive): suggestedVariant?, onAdded?(info).
- Specs written: e2e/scanner.spec.ts (3 tests x 375/390/430), e2e/scanner-helpers.ts, e2e/scanner-real.spec.ts, e2e/fixtures/scanner/make.mjs (Chromium canvas; generated 30 JPEG variants of 5 swsh3 references + unsupported.jpg, 4.3 MB, untracked).

## Verified (real output)
- npm run typecheck: clean. npm run lint: 0 errors, 23 warnings. npm test --workspace=@flashydex/mobile: 34 files / 456 tests passed (run before my last small edits; not re-run).
- Mocked e2e, mobile project, last full run (log: %LOCALAPPDATA%/Temp/s_all1.log), results seen:
  375 landing/states PASS; 375 offline-banner/nav PASS; 375 confirm->add->Scan Another->persist FAIL (5.0 m timeout, cause not diagnosed); 390 landing/states PASS; 390 offline-banner/nav PASS. The 390 flow test and all 430 tests were unseen when the run budget ended.
- Not run with my changes: e2e/routes.spec.ts, e2e/core-flow.spec.ts (core-flow "onboarding" passed once on the pre-change tree).

## Measurements (375 run)
- Landing: scrollHeight 812, Take Photo button 343x48 at x16,y136. scrollWidth <= innerWidth asserted at every state; passed at 375 and 390.
- Match art 260x363 (63:88). Stacked candidate tiles at 375: three 343x525 tiles at y156/693/1230 (page scrolls ~1.8k px). Tab FAB 60x60 at y736, label y798 (under the circle). /scan has no tab bar, so nothing overlaps the tiles.
- 390/430 tile rects and /scan height after add are printed as MEASURE lines in the log; not collected.

## Findings / open risks
- Probable existing bug (overlay.tsx, not mine): BottomSheet Cancel does not close under touch emulation; the header div calls setPointerCapture on pointerdown, so the click may not reach the button. Specs close the sheet with Escape. Seen in one failing run only.
- One earlier run timed out at "English catalog ready" (120 s) in the first mocked test; later runs installed fine. Cause unconfirmed.
- 375 flow-test failure diagnosed from the earlier log: submitPhoto() checked isVisible() on scan-capture right after page.goto('/scan'), before render, fell into the try-another path and waited forever for a file chooser. Fixed in scanner-helpers.ts (waits for either surface); the fix is NOT yet re-run.
- Recognizer limit is 30/min, 300/day per IP. scanner-real.spec.ts paces posts at 2.3 s and honours Retry-After, but the path pattern e2e/scanner also matches the real spec.
- scanner-real.spec.ts assumes swsh3-{19,20,136,33,84} exist in the recognizer index and dev catalog; unverified.
- Real iPhone photos, HEIC behaviour, and standalone-PWA camera caveats (ios-camera.md) remain unverified.
- Health check treats {status:'ok'} (raw service) and {ok:true} (proxy contract) as online.

## To finish
1. Diagnose the 375 flow test; run the mocked suite twice plus routes.spec.ts and core-flow.spec.ts.
2. Run scanner-real.spec.ts once and paste the results.
3. Append the docs/UX.md scanner appendix; touch .agent/m2-ready-ui.
