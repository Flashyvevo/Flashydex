Project root: C:/Projects/flashydex (cd there first). You are Claude Sonnet, fixing the last findings of GPT Sol's third review of FlashyDex Phase 1. Read `BRIEF.md` Agent rules, `docs/API.md` (incl. all Director notes), then **`.agent/reports/sol-review-3.md`** sections E01–E04 and the N04/N05/N07/N08 "partly" lines (file:line + fix direction are given). Rules: NO capture_screenshot / image viewing (crashes Anthropic sessions); browser session `session="fixf"`; never git commit; do not kill the HTTPS dev server on :3200.

## Your files: `packages/core/**`, `packages/schemas/**`, `apps/mobile/src/**` (logic only where E04/N04 require; no copy changes), `apps/mobile/e2e/**`, `.agent/reports/sonnet-fix-f-report.md`.

## Do (red test first, then fix, for each)
- **E01 (P1)**: concurrent import replay must never return success before the receipt is durable. Reproduce Sol's exact ordering (his probe is at `scratch/sol-e-probes.mts` path named in the report — reimplement it as a vitest test, don't depend on scratch), then fix: receipt lookup and commit under the same persistence/latch check, return only after durable commit confirmation; replay returns the stored receipt only if persisted.
- **E02 (P2)**: `.fdx` preview/restore must validate domain invariants (zod schemas from `packages/schemas` + FK/enum/money/date rules), not just hashes; reject with `BACKUP_INVALID` + a readable reason. Test with Sol's four acceptance probes recreated.
- **E03 (P2)**: ZIP reader rejects inconsistent local vs central headers (flags, method, sizes) and any encryption flag; test with crafted archives.
- **E04 (P2)**: dashboard totals and personal rows must come from one consistent read (same revision/generation or retry → STALE_READ); test the interleaving Sol describes.
- **N04 residue**: move `.fdx` ZIP/JSON parse + inflate off the main thread into a Web Worker (same bounded-slice logic), with a fallback path when workers are unavailable; keep tests green.
- Run `npm run typecheck && npm run lint && npm test && npm run build && npm run e2e` (e2e uses its own :3201 server). Paste results.
- Report `.agent/reports/sonnet-fix-f-report.md`: item → fixed/partly + test names; print it.
