# sonnet-fix-h-specs report

## Changed
- e2e/persistence-failed.spec.ts: rewritten for Stage F (3 tests, jeep IDB-put fault gone).
  1. worker dies after COMMIT, before the durability barrier -> persistence-failed latch seen (MutationObserver), no "Added" success, in-place recover() clears it (fresh worker), copy count exactly 2 (never 3), same after hard reload, catalog active ref/pool files unchanged, no staging, writes work again (3).
  2. same fault + `new Worker` blocked so recover() fails -> latch stays, honest Reload button, no "reloaded your data" claim, reload -> exactly 2 copies, storage intact.
  3. worker dies AT the COMMIT (message never executed) -> no success claimed, reload -> exactly the earlier 1 copy, storage intact.
- e2e/helpers.ts (additive): catalogPoolState(page) (pool catalog files + role-store active/previous + OPFS staging jobs, via in-page dynamic import of web-sqlite/role-store/opfs-staging, not harness.ts) and installWorkerDeath(page) (init-script wrapper of Worker.prototype.postMessage that swallows the next `commit` or `durableBarrier` message and calls client.__terminateWorker()).
- src/routes/dev/pack-test.tsx: no openCatalogDb; reads through getWebCatalogStorage().openCatalogDriver(lang,'ro').proxy; Remove uses releaseLanguage + removeCatalog; renders pool snapshots (pool-before-finalize taken after activate, pool-after after discardPrevious).
- e2e/pack-install.spec.ts: jeepKeys replaced by pool/role-store assertions; added a removal test; reinstall asserts previous kept (files = [old,new], previousRef=old) until finalize, then only the new one.
- No fault seam added to client.ts: NO contract change request. The existing __terminateWorker + the postMessage trap give precise timing.

## Spec runs (persistence-failed + pack-install, 10 tests)
Run 1: 10 passed (58.2s). Run 2: 10 passed (56.6s). (Before: 4 failed / 3 passed of 7.)

## Gates
typecheck 0 errors; eslint e2e src/routes/dev: 0 errors, 1 warning in web-install.spec.ts (other child's file); mobile unit tests 19 files / 241 passed.

## Real defect (found, not fixed - packages/core is out of scope)
packages/core/src/db/sql.ts:276-281: a COMMIT that rejects (e.g. WORKER_DIED, commitState `unknown`) is treated as a plain failure (ROLLBACK attempt, translateSqliteError). Only a failing afterCommit() barrier (sql.ts:290-295) sets persistenceFailed. Consequence on web: worker death exactly at COMMIT latches the client's rw wrapper (client.ts:265 handleDeath) but core never latches persistence_failed, so recover()/reopen is never invoked and every later write fails with WORKER_DIED until the user reloads, with no latch UI (contract §4 says unknown commit state must latch). Data-safe (test 3 shows no doubling), but a UX dead-end and a COMMIT-ack-lost-but-durable case would show "failed" while the row exists. Suggested fix: in runTransaction, treat commitState 'unknown' on COMMIT as persistenceFailed.

## Open risks
- Specs depend on module URLs `/src/platform/web-sqlite/index.ts` etc. (Vite dev server only) and on the message ops 'durableBarrier'/'exec'/'batch'.
- Test 1 relies on in-place recover() succeeding on the new path; the test would need updating if recovery becomes reload-only.
- Spec runs used 2 workers against the owner's server on :3200.
