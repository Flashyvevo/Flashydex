# sonnet-fix-j-storage-shell report

All gates green. `WEB_ATOMIC_ACTIVATION_PROVEN` is `false` and was never set true.

## S5-03 — flag honesty
- `pack-install/web-store.ts:18-29`: flag `false`. The comment lists the two conditions and the spec describes that prove them ("no outer boot retry", "boundary matrix").
- `pack-install/web-store.test.ts` (capabilities test): now asserts the flag is false, `atomicActivation: false` and the reason string. It went red after the flag flip, then I fixed it.
- `e2e/web-install.spec.ts` `openCore`: `window.__fdxNoOuterBootRetry = true` (set with `addInitScript`) disables the outer retry on "storage pool could not be opened". Context-reset retries stay. Default is unchanged.
- Kill group is now `for (noRetry of [false, true])`. The second copy is describe "no outer boot retry: kill tests".
  - It was fixme until the sibling's `web-sqlite/pool-boot-retry.ts` and `sql.worker.ts` diffs landed (seen on disk about 10 minutes in). It is now always on.
  - No-outer-retry kill group: `--repeat-each=10` gave **40 passed (3.9m)**. That is 4 tests x 10, zero failures.
  - I did not independently review the sibling's retry change. The 40/40 is what ran against the code on disk at that moment.
- Boundary matrix, describe "boundary matrix", 7 tests:
  - `first` and `update` installs killed at `prepared`, `before-pointer` and `after-pointer`.
  - An `update` install killed at `cleanup`. A first install has no previous generation, so there is no cleanup case for it.
  - `prepared`: a postMessage trap swallows the COMMIT of the `catalog_install_jobs ... 'prepared'` write.
  - `before-pointer`, `after-pointer`, `cleanup`: new DEV-only seam `window.__flashydexTest.webActivationHook(point)` in `web-store.ts` (`faultPoint`, in `activate()` and `discardPrevious()`). A hook that never settles stalls the install there, then the page is closed.
  - `web-storage/harness.ts`: `seedUserRows()` (3 custom cards + owned copies with notes) and `userCanon()` (sorted JSON dump of the personal tables). I used this instead of `readOwnedCopies`, because the harness page has no app routes. The comparison is a canonical dump of owned_cards, grades, custom_cards, groups and price_snapshots.
  - After the kill, a new page boots and reconciles. Each test asserts:
    - USER canon is byte-equal to the pre-fault dump.
    - staging and candidates are empty.
    - every generation file is referenced (no orphan).
    - an update always has an active, searchable catalog with the same total.
    - a first install is absent or searchable.
  - Observed outcomes:
    - `prepared` and `before-pointer`: previous catalog kept (or absent).
    - `after-pointer`: boot rolled back to the old active (or absent), because there is no receipt yet.
    - `cleanup`: the new catalog is active with exactly one generation.
  - Runs: the first standalone run was red because `userCanon` read rows as objects (they are arrays). I fixed it, and the next standalone run was 7/7. It then passed in both full gate runs.
  - Limit: the matrix tests use the default `openCore` (outer retry on). Only the kill group runs without it.

## S6-04 — tee bytes
- `pwa/image-cache/handler.ts:29-62`:
  - `tryAdmit(url, response, 'clone'|'direct')` takes a slot, then starts `readBounded` immediately. A clone never waits unread behind disk I/O.
  - Only `engine.admit` stays serial.
  - In-flight bytes are at most `slots * cap`. The production slot count is unchanged.
  - Revalidation consumes the network response directly ('direct', no clone). When busy, it cancels the body.
- Unit tests in `handler.test.ts` ("image handler tee bytes (S6-04)"):
  - A slow writer plus a streaming unknown-length 2 MiB body with `perEntryMax` 1024: the waiting clone started reading and read at most cap + 1 chunk, while the page read all 2 MiB. The oversized entry is never written.
  - Revalidation makes 0 clones, the body is `bodyUsed`, and the entry is admitted once.
  - Both are red against the old handler (verified by swapping in the HEAD version) and green now. The image-cache folder passes 25/25.
- `pwa/harness.ts`: the 30-image concurrent step uses `maxAdmissions: 64`, set in the harness only. New `runBusy()` uses the production slot count.
- `e2e/pwa-image-cache.spec.ts`:
  - "controlled admission: ledger engine holds the cap, LRU order, ..." keeps the old assertions.
  - "skip-when-busy: ..." uses 30 concurrent images with a 3000-byte cap. It asserts `1 <= admits < 30`, `waits == admits`, whole 200 bodies, peak and committed bytes within the cap, and Cache Storage keys equal to ledger rows.
  - Both ran 2/2 twice standalone, and passed in both gate runs.

## S6-06 — writer-lock release
- `platform/instance-lock.ts`:
  - `releaseWriterLock()` settles the held lock callback once (single owner) and returns true/false.
  - `isWriterLockReleased()`: after release, `acquireInstanceLock()` returns 'denied'.
- `lib/handoff.ts`:
  - `committed` is set at the point of no return. `isHandoffCommitted()` is true until `resetHandoffUi()` (tests or a fresh page).
  - Release happens only after every `closePath({drain:true})` and the worker shutdown.
  - A close or shutdown failure never releases the lock, because handles may still be open. The Reload overlay is shown and the unload releases it.
- `components/pwa-ui.tsx`:
  - `releaseWriterLock` is wired into `appHandoffDeps`.
  - The gate wrapper ignores `open()` once the handoff is committed, so old-page admissions are permanently invalid.
- Tests:
  - `handoff.test.ts`:
    - full order close → shutdown → release → activate.
    - activation failure: the lock was released before activate, Reload is offered, and the overlay stays blocked.
    - a stuck closePath or shutdown never releases.
    - the committed flag.
  - `platform/instance-lock.test.ts` (new, Web Locks fake): a blocked taker is not granted until release (no steal), a double release returns false, and the released page gets 'denied'.
  - `e2e/pwa-update-handoff.spec.ts`: two new same-context two-tab tests, for a successful handoff and for activation failure. Tab B is blocked behind the lock screen, A runs the handoff and stays open, and B becomes the writer and creates a location. A's later write is refused. The failure variant also shows the Reload button.
- Red proof: the stuck-close and ordering unit tests are new. I did not rerun the two-tab e2e against the old code. With the old code the lock callback never settled, so B could not be granted.
- Flakes seen while writing the e2e: B's lock screen briefly disappears during its reload, so B's write now uses `expect.poll`. One existing handoff test hit "Execution context destroyed" once (likely a Vite dev-server reload) and passed in all later runs.

## Gates
- `npm run typecheck`: 0 errors.
- `npm run lint`: 0 errors, 23 warnings (react-refresh and one unused-directive warning; I did not check which of them are pre-existing).
- `npm test --workspace=@flashydex/mobile`: 27 files, 337 tests passed.
- `npm test --workspace=@flashydex/core`: 34 files, 375 tests passed (untouched).
- Playwright, `web-install`, `pwa-image-cache`, `pwa-update-handoff` and `pwa-blocked-export`, `--project=mobile`:
  - run 1: `47 passed (1.9m)`
  - run 2: `47 passed (1.9m)`
- `e2e/full-install.spec.ts`: `1 passed (18.9s)`.

## Open risks
- Flag stays `false`. Sol's condition 1 is now evidenced (40/40 with no outer retry), but the matrix does not run without the outer retry, and it has only the two gate passes plus one standalone pass. Flipping the flag is a review decision.
- Core does not read `atomicActivation` (it is only a type), so setting it false changes only the capabilities report and the reason string. I did not check whether any UI gates on it.
- If handoff activation fails after a successful release, tab B can take the lock while A shows Reload. This is intended: A's storage is closed and its gate is permanently closed.
- A close or shutdown timeout leaves the lock held until reload. That is safe, but another tab stays blocked until the user reloads A.
