# sonnet-fix-l — close Sol review 8: S8-01 (P1 job-lifetime fence on handoff), S8-02, S8-03

Unattended run. Never ask questions. Repo `C:/Projects/flashydex` (start every shell with `cd C:/Projects/flashydex`). Do NOT `git commit/push/stash/reset/checkout`. You are the only builder.

## Read first
`.agent/reports/sol-review-8.md` — section 3 rows S8-01, S8-02, S8-03 IN FULL (they contain the concrete fix), the S7-01/S7-03/S5-04 rows, and the browser-probe section. Then `.agent/reports/sonnet-fix-k-report.md`, `.agent/stage-f-contract.md`, `docs/WEB-STORAGE.md` §2/§5/§7.

## Your files
`apps/mobile/src/lib/handoff.ts`, `apps/mobile/src/platform/app-database.ts`, `apps/mobile/src/platform/instance-lock.ts`, `apps/mobile/src/platform/web-storage/**` (NOT contract.ts), `apps/mobile/src/platform/pack-install/web-store.ts|web-port.ts`, `apps/mobile/src/platform/web-sqlite/client.ts|worker-core.ts|pool-boot-retry.ts|sql.worker.ts|protocol.ts`, `apps/mobile/src/data/install-hooks.ts`, `apps/mobile/src/data/transfer-sync-hooks.ts`, `apps/mobile/src/components/pwa-ui.tsx` (copy only), their tests, `apps/mobile/e2e/pwa-update-handoff.spec.ts`, `apps/mobile/e2e/web-sqlite.spec.ts`, `apps/mobile/e2e/web-install.spec.ts`. `packages/core` and `contract.ts` frozen — core's `catalog-install.ts` job shape is the given; fence at the adapter.

## Items
### S8-01 (P1) — whole-job lifetime fence
Handoff must not release the writer lock while any install/uninstall/rollback/sync/restore job admitted through the WorkCoordinator / install port is alive — "alive" = from admission until its final USER receipt transaction has settled, including role-store IDB transitions. Implement:
1. A job registry in the web runtime (`web-storage/runtime.ts` or a new `job-registry.ts`): the web install port / web-store wraps every core-driven job (stage/import/activate/discardPrevious/discardCandidate/remove/clearLanguage/rollback) and every sync/restore job registered via `install-hooks.ts`/`transfer-sync-hooks.ts` with a handle `{ id, kind, startedAt, signal, settled: Promise }`.
2. `retireStorage()`: (a) set the fence so NO new job can be admitted (reject at the port with `RETIRED`), (b) for active jobs: if cancellable via its AbortSignal and still before its first durable effect, abort and await settlement; otherwise await `settled` under a bounded wait (e.g. 20 s) — during that wait the retired page stays the authorized owner (lock NOT released, SQL write gate still open for THAT job only via an admitted-job token), (c) only then drain SQL paths, close, terminate, release the lock. If the wait expires, do NOT release the lock: show the explicit "An update is still finishing — Reload when it's done / Retry" state (the lock is released by unload).
3. Role-store transitions (`role-store.ts` ~142-162): check the fence at transaction EXECUTION time (inside the IDB tx callback before the put), not only at call time; a transition that already committed must report committed (never "rejected after commit").
Tests: unit — uninstall admitted, handoff requested, uninstall's role IO is held by a fixture tx → handoff waits, uninstall completes its receipt, THEN lock releases; job admitted after fence → RETIRED; bounded-wait expiry keeps the lock. Playwright (extend `pwa-update-handoff.spec.ts`): Sol's reproduction — A starts uninstall of the small EN catalog with role IO paused (use a `window.__flashydexTest` DEV seam to hold the IDB transaction), A triggers handoff, B (same context) is blocked until A's job settles, then B boots with a consistent receipt (installed+active or absent+no orphan — never installed+null active), search works; variant with install-in-progress; variant with sync job.

### S8-02 (P2) — executor-aware deadlines
`client.ts` ~74-75, 401-450, `worker-core.ts` ~238-260: tag heartbeats with the executing request id (the worker knows which request it is stepping); a queued `open`/`reopen` behind a progressing request must not expire while progress for the executing request keeps arriving — its deadline starts when it actually begins executing (worker posts `started {id}`), and hidden time is excluded. Keep: a genuinely silent worker still dies; a stalled async open with no progress still fails bounded. Tests: Sol's real-WASM case (long recursive SELECT + queued second-path open, short windows) → both succeed, 0 terminations; silent worker → dies; stalled open → INIT_FAILED/unknown bounded.

### S8-03 (P2) — hung acquisition
`pool-boot-retry.ts` ~90-158: the pinned initializer caches a PENDING promise; `forceReinitIfPreviouslyFailed` only helps after rejection. For a hung attempt (no settle within the per-attempt bound) the only safe recovery is to discard that worker: have the CLIENT supervise boot — if the worker's `init` doesn't settle within the attempt bound, terminate the worker and start a fresh one (ownership retained via the Web Lock), with preservation flags, backoff, and the total budget clipping the next attempt; never run two reservations in one pool. Make the test model cache-faithful (pending stays pending; a late resolve on the abandoned worker is ignored because the worker is gone). Tests: hung first attempt → fresh worker succeeds; late reject → forced retry in same worker; budget clipping; exhausted → INIT_FAILED with attempts list.

## Gates before reporting
`npm run typecheck` (0 errors), `npm run lint` (0 errors), `npm test --workspace=@flashydex/mobile` (all pass — run `client.test.ts` in isolation too if the known interleave flake trips under load), `npm test --workspace=@flashydex/core` (375), `cd apps/mobile && FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/pwa-update-handoff.spec.ts e2e/web-sqlite.spec.ts e2e/web-install.spec.ts --project=mobile` twice (all pass), `e2e/full-install.spec.ts` once.

## Don't
No screenshots / image viewing; `browser_exec` only with `session="fix-l"` + `cdp('Security.setIgnoreCertificateErrors', ignore=True)`. No `npm install`, no deps, no commits, no edits outside the list, never weaken a safety assertion, never flip `WEB_ATOMIC_ACTIVATION_PROVEN`, never release the lock before admitted jobs settle.

## Report
`.agent/reports/sonnet-fix-l-report.md` (draft FIRST): per item — what changed (file:line), red→green test names with red evidence, two verbatim spec-run summary lines, gate outputs, open risks.
