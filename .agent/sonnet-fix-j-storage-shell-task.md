# sonnet-fix-j-storage-shell — Sol review 6: S5-03 flag honesty, S6-04, S6-06, image-cache spec, outer-retry seam

Unattended run. Never ask questions. Repo `C:/Projects/flashydex` (start every shell with `cd C:/Projects/flashydex`). Do NOT `git commit/push/stash/reset/checkout`.

## Read first
`.agent/reports/sol-review-6.md` — rows S5-03, S5-04, S5-07, S6-04, S6-06, section 2 items 3–4, "Independent browser probe output" (image waiting tee), then `.agent/reports/sonnet-fix-i-storage-shell-report.md` (what you are amending), `.agent/stage-f-contract.md` §5, `docs/WEB-STORAGE.md` §4/§7.

## Your files (exclusive)
`apps/mobile/src/platform/web-storage/**` EXCEPT `contract.ts` and `write-gate.ts`, `apps/mobile/src/platform/pack-install/**`, `apps/mobile/src/platform/app-database.ts`, `apps/mobile/src/platform/pwa/**`, `apps/mobile/src/platform/instance-lock.ts`, `apps/mobile/src/lib/handoff.ts`, `apps/mobile/src/components/pwa-ui.tsx`, `apps/mobile/src/components/storage-screens.tsx`, `apps/mobile/e2e/web-install.spec.ts`, `apps/mobile/e2e/pwa*.spec.ts`. A sibling (`sonnet-fix-j-web-sqlite`) owns `web-sqlite/**` and `write-gate.ts` and is fixing the boot retry (S6-02) and liveness (S6-01) — do not touch those; `packages/core` frozen.

## Items
### S5-03 — flag honesty (do this FIRST, within 10 minutes)
1. `pack-install/web-store.ts:~25`: set `WEB_ATOMIC_ACTIVATION_PROVEN = false` and leave it false this round. Sol's conditions for `true`: production-equivalent boot after kill WITHOUT the spec's outer retry, plus a real-browser boundary matrix (PREPARED/pointer-transaction abort, kill on both sides of the pointer commit, kill during cleanup, canonical personal-data comparison). Add a comment above the flag listing exactly those conditions and the spec names that will prove them.
2. `e2e/web-install.spec.ts` ~187-202: make the outer `openCore` boot retry switchable — `window.__fdxNoOuterBootRetry = true` (set via `page.addInitScript`, DEV-only read) disables it. Default stays on so the suite remains green while the sibling fixes S6-02. Add a kill-group variant (or a `test.describe` with the init script) that runs with the outer retry OFF; it may be `test.fixme` until the sibling's fix lands — then (poll `git diff --stat -- apps/mobile/src/platform/web-sqlite/pool-boot-retry.ts apps/mobile/src/platform/web-sqlite/sql.worker.ts` every 10 min, max 60 min) turn it on and run it `--repeat-each=10`; report the real count.
3. Add the missing boundary-matrix browser tests Sol listed, using the existing postMessage-trap technique and `window.__flashydexTest.webInstallFault` seams: kill/abort (a) during PREPARED journal write, (b) just before the role-store pointer transaction, (c) just after the pointer transaction before cleanup, (d) during cleanup/discardPrevious. Each asserts: previous (or absent) catalog intact & searchable or new one active & searchable — never neither; no orphan generation after boot reconcile; USER rows byte-equal to a canonical export taken before the fault (`readOwnedCopies` in `e2e/helpers.ts`). Run twice.

### S6-04 (P2) — tee bytes, not just clone count
`pwa/image-cache/handler.ts` ~29-58, 77-80 and `read-bounded.ts`: a clone that is waiting for an admission slot must not accumulate bytes. Either (i) skip caching when no slot is immediately free (don't clone at all), or (ii) start the capped read immediately on admission with an aggregate in-flight byte budget. For background revalidation, consume the network response directly or cancel the unused branch. Tests: slow-writer + streaming unknown-length 2 MiB body with `perEntryMax: 1024` → the waiting clone never reads more than the cap; revalidation leaves no unconsumed branch.
Then fix `e2e/pwa-image-cache.spec.ts:42-47`: split into (a) controlled-admission cap/LRU test (serialize images or raise `maxAdmissions` via the harness, assert cap held and LRU order) and (b) a skip-when-busy test (K small, concurrent images, assert some served network-only and the cache never exceeds the cap). Never raise the production admission count to make it green. Run twice.

### S6-06 (P2) — writer-lock release in handoff
`components/pwa-ui.tsx` ~18-26, `lib/handoff.ts` ~83-84, 134-136, `platform/instance-lock.ts` ~30-39: expose a single-owner `releaseWriterLock()` that settles the lock callback; handoff calls it only after worker/handles are fully closed (after `closePath({drain:true})` on every path and worker shutdown), old-page admissions are permanently invalidated, then activation/reload. On activation failure the overlay must offer Reload and the lock must still be released. Tests: unit (order: close → terminate → release → activate), Playwright same-context two-tab: tab A holds the lock, handoff in A, tab B (previously blocked) can take the lock without steal; activation-failure path releases too.

## Gates before reporting
`npm run typecheck` (0 errors), `npm run lint` (0 errors), `npm test --workspace=@flashydex/mobile` (all pass), `npm test --workspace=@flashydex/core` (375; untouched), `cd apps/mobile && FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/web-install.spec.ts e2e/pwa-image-cache.spec.ts e2e/pwa-update-handoff.spec.ts e2e/pwa-blocked-export.spec.ts --project=mobile` twice (all pass both times), `e2e/full-install.spec.ts` once. Dev server already on :3200 — never start/kill it, never `npm run dev`.

## Don't
No screenshots / image viewing (kills the session); `browser_exec` only with `session="fix-j-storage"` + `cdp('Security.setIgnoreCertificateErrors', ignore=True)`. No `npm install`, no deps, no commits, no edits outside your list, never weaken a safety assertion, never set the proof flag true this round.

## Report
`.agent/reports/sonnet-fix-j-storage-shell-report.md` (draft FIRST): per item — what changed (file:line), red→green test names, the two verbatim spec-run summary lines, the no-outer-retry kill-group count (or "sibling fix not landed"), gate outputs, open risks.
