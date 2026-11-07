# sonnet-fix-m — P2 close-out after Sol review 9 (no P1 remains): S9-01 test reliability, S9-02 boot budget accounting, S5-09 validator values

Unattended run. Never ask questions. Repo `C:/Projects/flashydex` (start every shell with `cd C:/Projects/flashydex`). Do NOT `git commit/push/stash/reset/checkout`. Only builder.

## Read first
`.agent/reports/sol-review-9.md` rows S9-01, S9-02, S5-09 (section 3) and the S8-03 row.

## Your files
`apps/mobile/src/platform/web-sqlite/pool-boot-retry.ts`, `client.ts`, `sql.worker.ts`, `protocol.ts`, `client-fix-k.test.ts`, `client-fix-l.test.ts`, `client.test.ts`; `packages/core/src/services/candidate-validation.ts` + its tests (director-approved NARROW change for S5-09 only); nothing else.

## Items
### S9-01 — mobile gate must be reproducibly green
1. `client-fix-l.test.ts:211-216` ("every attempt is clipped…"): drive the policy with an injected fake monotonic clock/timers (vi.useFakeTimers or an injected `now()`/`sleep()` on the helper) so exhaustion is asserted against the chosen budget, not real-timer arrival.
2. `client-fix-k.test.ts:61-76`: the interval's `void client.listFiles()` leaks a WORKER_DIED unhandled rejection — catch all chatter promises; stop timers and terminate workers in `finally`/`afterEach`.
3. `client.test.ts` "USER statements interleave with the chunked import": `expected 2 to be greater than 2` under load — make the interleave deterministic (gate the import supplier on a controllable promise so at least N USER commits are forced between chunks) instead of relying on timing.
Prove: `npm test --workspace=@flashydex/mobile` passes 3 times in a row (paste the three `Tests` lines), with no "unhandled rejection" in the output; also run the three files with `--repeat 5` (vitest `--repeat`? if unavailable, loop 5×).

### S9-02 — one elapsed boot budget
`client.ts` ~247-307, `sql.worker.ts` ~106-123: the budget is ONE total elapsed boot budget (document it in a comment + `protocol.ts` constant). Compute remaining time again after `ready` and before sending `init`; the worker subtracts its own module-load/probe elapsed before entering pool retry and clips ready/init waits; never start an acquisition attempt after exhaustion; replacement workers (supervised boot) inherit the remaining budget, not a fresh one. Hidden-page suspension stays as documented. Tests with fake timers: delayed ready, slow module/probe, replacement startup, final diagnostics show the per-phase elapsed.

### S5-09 — validator compares receipt values and fingerprint (narrow core change)
`packages/core/src/services/candidate-validation.ts` ~24-50, 65-80: in addition to the actual schema SQL comparison, compare `schema_migrations` receipt rows (version + checksum) against the bundled catalog chain and compare `catalog_meta.schema_fingerprint` against the bundled fingerprint (the builder computes it in `tools/catalog-builder/src/migrations.ts`: SHA-256 over `version:checksum` lines — reuse/port that exact computation in core, do not re-derive differently). Mismatch → the existing `PACK_INVALID`/`APP_UPDATE_REQUIRED` classification (newer schema → APP_UPDATE_REQUIRED, otherwise PACK_INVALID). Tests: matching pack passes; tampered receipt row fails; tampered fingerprint fails; future schema → APP_UPDATE_REQUIRED. Confirm the real `.003` packs still validate: run `cd apps/mobile && FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/full-install.spec.ts --project=mobile` (installs the 64 KiB full EN) and `e2e/pack-install.spec.ts`.

## Gates
`npm run typecheck` 0 errors, `npm run lint` 0 errors, core all pass (count), mobile 3× green as above, the two Playwright files above.

## Don't
No screenshots/images; `browser_exec` only with `session="fix-m"`. No `npm install`, no commits, no other files, never weaken assertions, never flip `WEB_ATOMIC_ACTIVATION_PROVEN`.

## Report
`.agent/reports/sonnet-fix-m-report.md` (draft FIRST): per item what changed (file:line), tests, the three mobile `Tests` lines, open risks.
