# sonnet-fix-m report

Scope: S9-01, S9-02, S5-09. No commits, no files outside the listed set except one core test-support file (see S5-09), `WEB_ATOMIC_ACTIVATION_PROVEN` untouched, no screenshots, no npm install.

## Gates (all executed)
- typecheck: 0 errors. lint: 0 errors (23 pre-existing warnings).
- core: 34 files, `Tests  380 passed (380)` (was 375; +5 S5-09 tests).
- mobile, 3 consecutive full runs (`npm test --workspace=@flashydex/mobile`), 0 "unhandled" matches in all three logs (`.agent/scratch/mobile-run{1,2,3}.log`):
  - run 1: `Tests  406 passed (406)`
  - run 2: `Tests  406 passed (406)`
  - run 3: `Tests  406 passed (406)`
- The three files (client-fix-k, client-fix-l, client.test) looped 5x: `Tests  67 passed (67)` x5, no unhandled rejection, no FAIL.
- Playwright (`--project=mobile`, https://127.0.0.1:3200): `e2e/full-install.spec.ts` + `e2e/pack-install.spec.ts` = 8 passed. full-install installed the full EN pack (23,736 cards; validation ran against the real receipts and fingerprint); pack-install EN + JA passed. Real packs validate with the new checks.

## S9-01 - reproducible green
- `pool-boot-retry.ts:138-153`: exhaustion is decided by the chosen budget. An attempt whose bound was clipped to the remaining budget (`remaining <= attemptLimit`) that hangs reports `exhausted:true` regardless of the timer's fractional arrival (root cause of "hung:true, exhausted:false" at a nominal 60 ms).
- `client-fix-l.test.ts` (the "every attempt is clipped" test, now fake timers + injected `now`): still pending at 59 ms, exhausted at 60 ms with `attempts[0].elapsedMs === 60`, no acquisition after exhaustion. Added: clock reading 59.4 of 60 is still exhausted; a hung attempt on its own shorter limit inside a larger budget is hung but NOT exhausted.
- `client-fix-k.test.ts:71-78`: chatter `listFiles()` promises are caught; the interval is cleared in `finally` (this was the leaked WORKER_DIED unhandled rejection).
- `client.test.ts` "USER statements interleave...": no timing. `pool.importDb`'s supplier is gated after chunk 2 on a promise the writer releases once >= 3 USER commits have landed; asserts chunksServed > 2 and that >= 3 commits happened while the import was held mid-flight; restored in `finally`. The old `chunkDelayMs` timing is gone.
- Not changed: fake workers' own `setInterval` heartbeats in fix-k/fix-l are not cleared on terminate; they are guarded by the `dead` flag and caused no unhandled output in 8 runs.

## S9-02 - one elapsed boot budget
- `protocol.ts:10-20`: constant documented as ONE total elapsed boot budget (ready, replacement workers, backoff, module load, probe, acquisition); new `POOL_BOOT_REPLY_GRACE_MS = 1000`; `WireError`/`wireError`/`fromWire` carry `exhausted`, `moduleMs`, `probeMs`.
- `client.ts` `startSession`/`bootWorkerOnce` (~247-345): remainder is recomputed from the single `started` timestamp. Ready wait clipped to the remainder (a clip timeout is `exhausted`); remainder re-measured after `ready` and sent as `bootBudgetMs`; if <= 0 init is never sent; init deadline = `min(initDeadline, remaining + grace)`; a replacement worker is only started with budget left and inherits the remainder. Final exhausted error carries `attempts`, `phases` (`{worker, phase: ready|init|backoff, elapsedMs}`) and `elapsedMs`. Hidden-page deadline behaviour is untouched.
- `sql.worker.ts` `boot()` (~106-145): measures module-load and probe time, subtracts it via `remainingBootBudgetMs` (new, `pool-boot-retry.ts`) before the pool retry, throws exhausted without starting an acquisition when <= 0, and reports `moduleMs`/`probeMs`/`exhausted`/`hung` in the failure.
- `pool-boot-retry.ts`: `budgetMs <= 0` throws before the first attempt.
- Tests (fake timers incl. `performance`; `client-fix-l.test.ts` "S9-02" describe + one pool-level test): delayed ready (init budget <= 150 of 200), ready slower than the budget (init never sent, phases = ready, worker terminated), slow module/probe (worker model refuses acquisition, phases ready+init, no restart), replacement workers (each init budget <= 100 - 30*n and strictly decreasing, backoff + ready phases present, total elapsed <= budget + 10).

## S5-09 - validator values
- `candidate-validation.ts`: `BUNDLED_RECEIPTS` from `CATALOG_MIGRATIONS` (version + `migrationChecksum`, the same SHA-256 of the LF-normalised SQL the builder writes); `CATALOG_CHAIN_FINGERPRINT` = SHA-256 over `version:checksum\n` lines (1:1 port of `tools/catalog-builder/src/migrations.ts` `schemaFingerprint`, using core's sync `sha256Hex`). `checkMeta` (so also `validateActiveCatalog`) now, after the schema-version check, runs `checkReceipts` and compares `catalog_meta.schema_fingerprint`. Receipt mismatch/missing -> PACK_INVALID; a receipt chain extending the bundled one with an intact prefix, or schema_version newer -> APP_UPDATE_REQUIRED. `CATALOG_CHAIN_FINGERPRINT` exported from `index.ts`.
- `testing/fake-install-port.ts:5,128`: the fake pack now writes the chain fingerprint (it previously wrote `CATALOG_SCHEMA_FINGERPRINT`, the sqlite_master-object hash, which differs from what the builder stores). One file outside the listed set; needed for the matching-pack test.
- Tests in `test/candidate-validation.test.ts`: formula equals an independent node:crypto computation; matching pack installs; tampered receipt (checksum / version / deleted) -> PACK_INVALID; extra future receipt -> APP_UPDATE_REQUIRED; tampered or empty fingerprint -> PACK_INVALID; future schema -> APP_UPDATE_REQUIRED even with differing receipts.

## Open risks
- `sql.worker.ts` boot() has no unit test (it imports the real WASM/OPFS). The worker-side subtraction is covered through `remainingBootBudgetMs` plus a client test with a worker model, and indirectly by the Playwright installs, not by a test that stalls a real module load.
- The init deadline now ends at remaining budget + 1 s instead of 30 s; a worker silent past the budget is declared dead sooner (intended by S9-02, but a behaviour change).
- The budget is wall-elapsed on the main thread, so hidden-page time counts against it (request deadlines still pause while hidden, as before).
- Any previously built pack whose `schema_fingerprint` is not the chain hash is now rejected; the real dev packs (full64, EN/JA dev packs) pass.
