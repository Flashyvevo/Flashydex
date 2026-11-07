# sonnet-live-scan report

Status: green (all gates passed). Not committed. Marker `.agent/m2-ready-live` touched.

## Files
New: `src/lib/recognition/{camera,frame-quality,retry}.ts` (+ `camera.test.ts`, `frame-quality.test.ts`), `src/components/scanner/{live-view,coach}.tsx`, `src/components/scanner/use-rear-camera.ts`, `e2e/scanner-live.spec.ts`, `e2e/scanner-live-helpers.ts`.
Changed: `src/routes/_modal/scan.tsx`, `src/components/scanner/scan-flow.tsx` (outcome/onRetry/priorNoMatches/onOutcome/coach props), `src/data/recognition.ts` (`runScan` extracted, `useLiveSession`), `src/lib/recognition/{copy,prepare}.ts` (copy + coachBullets; `encodeJpeg` exported), `e2e/scanner.spec.ts` + `scanner-real.spec.ts` (use `/scan?camera=file`; URL regex tolerates the query; the no_match/no_card loop reloads between the two because a 2nd consecutive no-match now shows the coach), `docs/UX.md` (new "Live Scan" subsection).
Deviations: pure retry policy lives in `lib/recognition/retry.ts` (stateful part in `data/recognition.ts`); live Playwright suites are a new `scanner-live.spec.ts` rather than inside `scanner.spec.ts`; `useRearCamera` is its own file (fast-refresh lint rule). `packages/core/test/catalog-repo.test.ts` shows as modified in git but was not touched by this task.

## State machine
`useLiveSession`: live -> analyzing -> { result | error | live(retrying chip) | coach }. no_match/no_card = failed attempt, 3rd -> coach; match/candidates -> result; network/5xx/429 -> error screen, not counted. reset() on Scan Another / Keep Scanning / Try another / unmount. Camera runs only while phase is live/analyzing and no file shot is shown; result, error and coach release it (Scan Another reopens). Denied/unavailable/blank/lost camera -> file-input landing with a muted "Using the camera app" line; a track lost mid-analysis keeps the in-flight result. File mode: 2nd consecutive no-match photo renders the coach (Try another keeps the streak; Scan Another / Keep Scanning reset it).

## Thresholds
MIN_SHARPNESS 45 (Laplacian variance), MAX_GLARE 0.06 (luma>245, central 70 %), MIN_BRIGHTNESS 45, sample long edge 320, ~6 fps, auto-capture after 4 consecutive passes. Reason priority dark > glare > blur. Retry: <=3 attempts per 10 s, >=1.5 s between starts, 3 failures -> coach. Observed gaps 1.65-1.70 s, span ~3.3 s. Coach lead needs >=3 rejected samples. Tuned on synthetic frames only.

## Gates (verbatim)
- typecheck exit 0; lint exit 0 (0 errors, 23 pre-existing warnings); mobile unit: Test Files 36 passed (36), Tests 469 passed (469).
- scanner.spec.ts run 1: `9 passed (1.7m)`; run 2: `9 passed (1.8m)`.
- scanner-live.spec.ts run 1: `17 passed (2.5m)`; run 2: `17 passed (2.5m)`.
- routes.spec.ts + core-flow.spec.ts: `3 passed (40.6s)` (an earlier attempt failed only because the Playwright webServer could not start, exit 3221225794; rerun on port 3212 passed).
- Caveat: typecheck/lint/unit ran before the last e2e-only edits to scanner.spec.ts (URL regex, goto in the loop); they were not re-run after those edits. The later e2e runs above all passed.

## Measurements (Playwright)
- Viewfinder 343x406 @375x812, 358x422 @390x844, 398x466 @430x932 = 0.50 of viewport (limit 0.62). Shutter 64x64 and Browse by Set bottom edge inside the viewport at all three; no horizontal overflow; all buttons >= 44 px (asserted). Guide aspect within 0.02 of 63:88.
- Fallback wall times (4.2-6.8 s) include onboarding, so they are not camera latency; blank detection is 2.5 s by construction.

## Covered by live suites
Glare/blur/dark rejected (no upload); auto-capture -> multipart JPEG -> match -> add -> Scan Another reopens viewfinder; tracks ended on result/coach/route leave; manual shutter, never twice in flight; 3-attempt coach with timing; glare/light/dark-surface leads; Keep Scanning; Take Photo opens file chooser; 429 = error screen, not an attempt; blank/denied/missing silent fallback; track lost idle and mid-analysis; hidden pauses video/sampling; file-mode coach after 2 no-matches.

## Open risks
- [needs owner iPhone] Standalone iOS viewfinder unverified (WebKit 282327 / 215884): may always fall back, or die ~90 s in; fallback is silent so the worst case is the old flow. Permission prompt frequency per Scan Another is unknown (camera is reopened each time so the indicator is off on result screens); if Safari re-prompts, keep the stream paused instead of stopped.
- Thresholds (sharpness especially) untuned on real sleeved/holo cards and real lighting; the 4-sample streak at 6 fps may feel too eager or slow hand-held.
- Battery/heat over long sessions unmeasured (6 fps getImageData + live video).
- React StrictMode (dev) opens the camera twice on mount; production opens once.
- Live frames are double-encoded (guide crop JPEG q0.85, then `prepareImage` re-encodes); no resize, small quality cost.
- `window.__fdxFakeCamera` and `?camera=` are gated on `import.meta.env.DEV`.
