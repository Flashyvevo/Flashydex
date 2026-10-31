Project root: C:/Projects/flashydex (cd there first). Product name FlashyDex / package `flashydex`.

# Role: sonnet-core-e — Claude Sonnet builder, Stage E (close GPT Sol's second-review findings, core side)

A parallel child (`sonnet-copy-e`) is editing user-facing strings in `apps/mobile/src/**` right now. A later child
(`sonnet-mobile-e`) will do the app side of this work. You never edit apps/mobile except the single exception below.

## Read (in order)
1. `.agent/stage-e-contract.md` — BINDING public-surface additions (E1–E4). Implement the core side exactly.
2. `.agent/reports/sol-review-2.md` — all of it; your items are N01, N02, N03 (core), N04, N05, N06, N07 (core), N08, plus
   cheap core-side residue of R06/R07/R10/R11. Each finding has file:line, Sol's measured probe, and the fix.
   Sol's probe scripts are in `C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/sol-d-probes.mts` and
   `sol-d-races.mts` (+ `.log` outputs) — read them; reproduce the scenarios as permanent tests.
3. `docs/API.md` (Director notes sections at the end, especially "Stage D"), `.agent/stage-d-contract.md`,
   `.agent/DIRECTOR-DECISIONS.md` D40–D47, `docs/IMPORT-EXPORT.md` (.fdx section), `docs/CATALOG-PACKS.md` (installer
   state machine).
4. Code: `packages/core/src/**`, `packages/core/test/**`, `packages/schemas/src/**`, `tools/catalog-builder/**`.

## Your files (ownership)
`packages/core/**`, `packages/schemas/**`, `tools/catalog-builder/**`, `docs/API.md` (ONLY by appending
`## Director notes — Stage E (2026-10-31)`). Single exception: if adding `maintenance` to `StorageStatus` breaks
`apps/mobile` typecheck, you may add `maintenance: null` to the NOT_READY/default snapshot in
`apps/mobile/src/data/context.ts` (and nowhere else in apps/mobile).

## Method — red then green, for every item
For each N-item: FIRST write a test that reproduces Sol's exact scenario and watch it FAIL (paste the failing assertion
line into your report), THEN fix, THEN green. Do not weaken or delete existing tests to make them pass; where Sol says a
test endorses wrong behaviour (persistence-latch.test.ts:89–98 for N05), change that test's expectation and say so.

## Do
- N01 (P1) activation/recovery must never discard the only valid previous catalog. Validate the ACTIVATED file (cheap
  check: schema fingerprint + catalog_meta language/version vs target) BEFORE committing the receipt and BEFORE
  discardPrevious; on failure restorePrevious + keep old receipt. Boot recovery: validate active before discarding
  previous; on mismatch restore the validated previous and its receipt. Handle the web adapter's state where
  active+previous+candidate all exist after the active put (undoSwap must not equate candidate-present with
  activation-not-completed; reconcile by content identity, e.g. catalog_meta version / journal targetVersion). Tests:
  Sol's three probes (active-not-revalidated, recovery-destroys-valid-previous, web-active-put-window) + corrupt-active-
  with-good-previous. Extend the fake port to model the web key-write boundary (not only rename-style). Do not compare
  refreshed (mutable) catalogs to the baseline SHA.
- N02 (P1) pending sync batches fence on a PERSISTED installed content identity (e.g. receipt sha256+version, or a
  persisted generation counter stored with the install receipt), not the in-process epoch counter. Test: real install via
  CatalogInstallService → kill between pending commit and catalog commit → cold reopen (new services, same files) →
  changed upstream → first observation (27) wins; and install replacement between attempts → batch discarded.
- N03 (P1, core half) contract E1: maintenance gate in the user Db / transaction queue; restore runs privileged. Tests:
  concurrent update/add/import-commit/settings-update at safety-snapshot and at activation boundaries → MAINTENANCE,
  final rows = archive values; status/subscribe emits maintenance enter/exit.
- N04 (P1) bound .fdx inflation allocation: feed compressed input in small slices with a proven worst-case expansion
  bound (DEFLATE max ratio ~1032:1 → e.g. ≤ 1 KiB compressed slices against a per-entry remaining budget) and stop as
  soon as cumulative output exceeds the cap; assert in a test that the largest single inflate callback chunk stays below
  a stated bound (Sol measured 67,108,864 bytes with a 66 KB archive and 1 MiB cap). Moving ZIP/JSON to a worker is the
  mobile side's call — expose nothing new for it; just make the core parse incremental/yielding-friendly if cheap.
- N05 (P1) contract E3. Update persistence-latch tests: PRE and POST persisted states reject before recovery, apply/
  return exactly once after.
- N06 (P2) contract E4; tests for all-set and mixed-set failure (status + lastError + resume works).
- N07 (P2, core half) contract E2; test the existing-reader ordering (pause after COUNT, activate, continue) for search,
  card detail, set cards, dashboard → correct result or typed STALE_READ/MAINTENANCE, never a raw driver error.
- N08 (P2) .fdx CRC32: verify per-entry CRC32 of the inflated bytes against central+local headers; reject local/central
  mismatch; CRC-only corruption test (Sol's: all six CRC fields set to 0x12345678) → BACKUP_INVALID (or a precise code
  you add and document).
- Residue (cheap only, skip if > 30 min each and say so): R06 covered by N01; R07 covered by N02; R10 covered by N07;
  R11: bind the catalog-builder run identity to git content (e.g. `git rev-parse HEAD` + dirty flag) instead of the
  hard-coded package version, and do not reuse 24 h detail cache for card details first seen in a new run — if larger,
  leave a TODO and report.
- Append the Stage E Director notes section to docs/API.md (E1–E4 as implemented + any new error code).

## Don't
- No screenshots / image viewing ever (crashes the session). Browser not needed; if you use it, `session="core-e"`.
- No git commit/push. Do not start a dev server or touch the HTTPS server on :3200. No edits to BRIEF/SPEC/other docs.

## Verify (all must pass before reporting)
`npm run typecheck --workspace=@flashydex/core && npm run typecheck --workspace=@flashydex/schemas`,
`npm run test --workspace=@flashydex/core`, `npm test --workspace=@flashydex/catalog-builder`,
`npm run typecheck --workspace=@flashydex/catalog-builder`, and `npm run typecheck` at root (mobile must still typecheck).

## Report
`.agent/reports/sonnet-core-e-report.md`: per N-item → test names (file:line), red evidence line, fix summary (file:line),
green; residue done/skipped; test counts per file from actual output; contract deviations.
