# sonnet-fix-h-webinstall — make `e2e/web-install.spec.ts` green on the Stage F tree

Unattended run. Never ask questions. Repo: `C:/Projects/flashydex` (start every shell with `cd C:/Projects/flashydex`). Branch main, working tree has the uncommitted Stage F work — do NOT `git commit/push/stash/reset/checkout`.

## Context
Stage F = production web storage: `@sqlite.org/sqlite-wasm` opfs-sahpool in a worker (builder A, `apps/mobile/src/platform/web-sqlite/**`), OPFS pack staging + role store + activation (builder B, `apps/mobile/src/platform/web-storage/**`, `apps/mobile/src/platform/pack-install/**`, `app-database.ts`). Read `.agent/stage-f-contract.md`, `docs/WEB-STORAGE.md` §4–§5, and `.agent/reports/sonnet-web-install-report.md` (especially "Run 2": B wrote v2-pack update/rollback/kill specs but never ran them).

The director has since changed catalog packs to **64 KiB SQLite pages (ADR-055 in docs/DECISIONS.md)**. The full EN dev pack is now:
- `/dev-packs/full/catalog-manifest.json` → EN `fullPackUrl` `/dev-packs/full64/catalog-en-2026.10.31.002.db.zst`, `uncompressedBytes` **120848384**, `compressedBytes` 12344689, 23,736 cards. (The old 138,002,432-byte / sha `bbca47b3…1606` constants are obsolete.)
- Small dev pack unchanged at `/dev-packs/catalog-manifest.json`.
Read the numbers from the manifest at runtime instead of hard-coding them wherever the spec currently hard-codes them.

The dev server is ALREADY running at `https://127.0.0.1:3200` (owner's; never start/kill a server on :3200/:3201, never run `npm run dev`). Run specs with:
`cd apps/mobile && FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/web-install.spec.ts --project=mobile --reporter=line`

## Current failures (full suite run by the director)
```
web-install.spec.ts:90  OPFS stage worker › cancel mid-flight through AbortSignal -> CANCELLED and no staging left
web-install.spec.ts:99  OPFS stage worker › FULL EN pack: staged + decoded + hashed in the worker, heap < 128 MiB, bounded chunks
web-install.spec.ts:234 web install through core › update keeps previous until commit; discardPrevious reclaims; second generation replaces the first
web-install.spec.ts:379 kill tests › first install killed mid-decode -> absent catalog, no staging, no orphan generation, USER untouched
web-install.spec.ts:400 kill tests › update killed mid-decode -> previous catalog intact and searchable, no staging, one generation
web-install.spec.ts:400 kill tests › update killed mid-import -> previous catalog intact and searchable, no staging, one generation
```
(8 others in the file passed.) Likely causes: stale 138 MB/sha constants; B's v2-pack builder (`buildV2`) rewriting a 14-char version string in a file whose layout changed; timing assumptions for the kill tests now that decode/import are faster; the `:90` cancel test racing a faster pipeline.

## Your files (exclusive)
`apps/mobile/e2e/web-install.spec.ts`, `apps/mobile/src/platform/web-storage/harness.ts`, and — only if a spec exposes a REAL product bug — `apps/mobile/src/platform/web-storage/**` (not contract.ts), `apps/mobile/src/platform/pack-install/web-store.ts|web-port.ts|opfs-stage*.ts`. Nothing else. Do not touch `packages/core/**`, `web-sqlite/**`, `pwa/**`, routes/components, other specs.

## Do
1. Run the spec file once to see the real failure messages (`--reporter=line`, read `test-results/*/error-context.md`).
2. Fix the spec/harness so every test in the file passes **in one invocation** (`14+ passed, 0 failed`), and then run it a second time to prove it is not flaky. If a test is inherently racy, make it deterministic via the existing fault/abort seams (`window.__flashydexTest.webInstallFault`, `abortAfterMs`), not by sleeping.
3. If a failure is a real product defect (e.g. a kill mid-import leaves an orphan generation, or `discardPrevious` unlinks a referenced ref), FIX IT in B's files with a red-first test and call it out in the report as a P0/P1 finding with file:line.
4. Keep the heap assertion (`< 134,217,728`), the staging-dir-removed assertions and the "USER untouched" assertions — never weaken a safety assertion to make a test pass.
5. Gates before reporting: `npm run typecheck` (root, 0 errors), `cd apps/mobile && npx eslint e2e/web-install.spec.ts src/platform/web-storage src/platform/pack-install` (0 errors), `npm test --workspace=@flashydex/mobile` (all pass), `npm test --workspace=@flashydex/core` (367 pass).

## Don't
- No `capture_screenshot`, no viewing images (kills the session). DOM/text only. If you use `browser_exec`, use `session="fix-h-webinstall"` and `cdp('Security.setIgnoreCertificateErrors', ignore=True)`.
- No `npm install`, no commits, no new deps.
- Don't run the whole Playwright suite (another child is running other spec files against the same server; parallel contexts are fine).

## Report
Write `.agent/reports/sonnet-fix-h-webinstall-report.md` (write a draft FIRST, refine at the end): what changed (files + why), final two consecutive spec runs (counts), gate results, any real defects found with file:line, measured FULL EN numbers (download/decode/import/validate/activate ms, heap peak, storage usage), open risks.
