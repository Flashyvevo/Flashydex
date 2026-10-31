Project root: C:/Projects/flashydex (cd there first). Product name FlashyDex / package `flashydex`.

# Role: sonnet-mobile-d — Claude Sonnet builder, Stage D (close GPT Sol's review findings, app side)

You are one of two builders running IN PARALLEL. The other (`sonnet-core-d`) owns `packages/core/**`,
`packages/schemas/**`, `tools/**`. You own `apps/mobile/**` (plus `scripts/ios-notes.md`) and never edit core/schemas.
The binding interface is `.agent/stage-d-contract.md` — read it FIRST and implement its app side exactly.

## Coding against core while it is being built
The core child will create `.agent/stage-d-core-types-ready` once the new public types compile (CatalogInstallPort v2,
`Services.storage`, `createServices({catalog, userWriteBlock})`, `SqlDriver.reopen?`, `SyncCapabilities.incremental`,
backup schemas/DTOs, BackupService). Until then: write code against the contract names, work on the parts that do not
depend on them first (R05 worker backpressure + its test, R01 Web Locks, R04 native store, R13 picker size check, e2e
scaffolding). Poll for the marker with `test -f .agent/stage-d-core-types-ready` (sleep 120 between checks, foreground).
Once it exists, read it and the actual exported types in packages/core/src and packages/schemas/src, then make
apps/mobile typecheck. If the real core types differ from the contract, follow the REAL code and note it in your report.
Core behaviour (backup create/restore, sync refresh) may still be landing when you first wire the UI — re-run e2e near the
end; if a core method still throws UNSUPPORTED_CAPABILITY at your deadline, leave the UI honest (capability-driven) and say so.

## Read
1. `.agent/stage-d-contract.md` (binding; director decisions D40–D46).
2. `.agent/reports/sol-review.md` sections 2 and 3. Your items are quoted below.
3. `docs/API.md` (CatalogInstallService, Platform adapter, TransferService/BackupService, Director notes incl. hook surface),
   `docs/IMPORT-EXPORT.md` (".fdx backup v1"), `docs/CATALOG-PACKS.md` (manifest, installer state machine, Director notes),
   `docs/UX.md` (backup/restore copy + the settings/data screen), `.agent/research/device-storage.md`,
   `.agent/research/capacitor-plugins.md`.
4. Current code: `apps/mobile/src/platform/**`, `apps/mobile/src/data/**`, `apps/mobile/src/routes/_tabs/settings/data.tsx`
   (backup + restore sheet already exist, currently capability-disabled), `apps/mobile/e2e/**`, `scripts/ios-notes.md`.

## Owner rulings (binding)
- R01 (P0): Web Locks per D42. `navigator.locks.request('flashydex-user-writer', {mode:'exclusive', ifAvailable:true}, cb)`
  where cb returns a promise that never resolves (held for page lifetime) — acquire BEFORE opening the user DB / jeep store.
  Not granted → do NOT open storage; render a full-screen INSTANCE_LOCK state: title "FlashyDex is open in another tab",
  body "Close the other tab, then reload this one.", a Reload button; `data-testid="instance-lock"`. When the other tab
  closes (lock released) you may offer takeover via a blocking (non-ifAvailable) request that resolves → reload.
  `navigator.locks` undefined → open storage but pass `userWriteBlock:{reason:'instance_lock', message:...}` to
  createServices and show a persistent banner `data-testid="writes-blocked"` ("Editing is off: this browser can't
  guarantee only one FlashyDex tab writes. Open FlashyDex over https or on localhost."). Native (Capacitor ios/android):
  no lock. Playwright: two pages in one context → second shows instance-lock; close first → second can reload and edit;
  reload of the single tab still works (lock released on unload).
- R02 (UI part): subscribe to `services.storage`; on `persistence_failed` show a blocking banner/sheet
  `data-testid="persistence-failed"`, disable mutation buttons, call `services.storage.recover()`; if recover rejects
  (web reopen unsupported) offer a "Reload" button that does `location.reload()`. Fix `lib/errors.ts:39–40` copy so it
  never claims a reload that did not happen. After recover → `queryClient.invalidateQueries()`. Implement
  `SqlDriver.reopen` for the user driver only if you can prove it re-reads the PERSISTED DB without saving memory first
  (jeep `closeConnection` saves to the store — check jeep-sqlite source in node_modules before deciding).
- R04: D44. Native writable catalog = copy of the active catalog into the plugin's writable databases directory opened via
  `createConnection` (and copied back / re-pointed per your design — document the design in native-store.ts), NC stays
  read-only for validation. Keep `catalogWrites:false` on native (so `CatalogSource.writable=false` and prices_only shows
  disabled) until a Mac run proves it; leave `// TODO(R04-mac)` at the switch and add numbered test steps to
  `scripts/ios-notes.md` ("Native writable catalog (R04)"). Web keeps catalogWrites:true.
- R05: bounded decoded-byte backpressure INSIDE the worker: feed fzstd compressed input in small slices (e.g. ≤64 KiB) and
  after each slice await acks until decoded-but-unacked bytes ≤ a cap (e.g. 4 MiB); a single push that would expand beyond
  a hard cap (e.g. 32 MiB of pending output, or the remaining uncompressedBytes budget) aborts with PACK_INVALID; total
  decoded > entry.uncompressedBytes aborts immediately. Count `pendingBytesMax` in metrics. Unit test (vitest, node) with a
  high-ratio synthetic frame (e.g. zstd of 64 MiB zeros — generate with fzstd's encoder or a checked-in tiny fixture made by
  a node script using the `zstd` CLI/`@mongodb-js/zstd` if available; otherwise compress with the catalog-builder's zstd
  util via a script, and commit only the small .zst fixture) proving pending bytes never exceed the cap and the oversize
  case aborts. Refactor the feed/emit logic into a pure module the test can import (worker shell stays thin).
- R06 (adapter part): implement CatalogInstallPort v2 `stage/openForValidation/activate/restorePrevious/discardPrevious/
  discardCandidate/inspect/remove` on web + native. `inspect` reads disk/IndexedDB truth (native: Filesystem.stat of
  catalog-<lang>.db / .previous.db / staging files; web: store keys) — no in-memory Set. Delete the adapter's own
  validateCatalog (core validates via openForValidation).
- R08 UI: backup/restore rows become enabled when `useBackupCapabilities()` says true. Create → share/download
  (`platform.share`) → record `flashydex.lastBackup`. Restore: pick (.fdx, kind 'backup', maxBytes 512 MiB) → preview
  sheet showing counts, catalog matched/missing, warnings, the literal warning "Replaces all personal data" → type-to-confirm
  `RESTORE` (or a destructive confirm button that sends `confirm:'RESTORE'`) → progress → success toast + invalidate all
  queries, show safety-backup info. Error copy for BACKUP_INVALID / BACKUP_VERSION_UNSUPPORTED / PREVIEW_EXPIRED /
  STALE_PREVIEW / ALREADY_RESTORED / SIZE_LIMIT in lib/errors.ts. Web file picker must accept `.fdx`.
  Also enable "Refresh this set" / incremental UI when `sync.capabilities()` reports them true (R07 UI).
- R09 client: `apps/mobile/src/platform/catalog-config.ts` (manifestUrl from `FLASHYDEX_MANIFEST_URL`, trustedOrigins from
  `FLASHYDEX_TRUSTED_ORIGINS` + defaults + DEV page origin), passed to createServices `catalog`. Manifest fetch reads the
  body with a stream reader and stops at maxBytes (PAYLOAD_TOO_LARGE) — never `response.text()` first. The worker checks the
  pack response's final `response.url` origin against trustedOrigins. Remove prefix-only URL checks that core now owns.
- R12 note: add `docs`-free note `apps/mobile/PERF-PROCEDURE.md` (or a section in scripts/ios-notes.md): how to measure
  on device per PHASE1-ACCEPTANCE 63–65 (10 warmups, 100 samples, p50/p95/max, 10k copies, `fdx:*` measures, long tasks
  during install/flush). Procedure only, no fabricated numbers.
- R13 (cheap parts): web/native picker checks `file.size` against maxBytes BEFORE reading bytes; add an app-owned
  `apps/mobile/ios/App/App/PrivacyInfo.xcprivacy` declaring the required-reason APIs you can source-verify are used
  (UserDefaults via Capacitor Preferences if used, file timestamp, disk space if used) — mark it "needs archive audit on
  Mac" in ios-notes; do NOT change ITSAppUsesNonExemptEncryption. Native CapacitorHttp metadata path: list as remaining
  unless trivial.

## e2e (Playwright, existing config, server already on :3200 — do not start another)
- `core-flow.spec.ts` gains: after the existing add flow → create .fdx (capture the download) → open a FRESH browser
  context (= reinstall) → onboard + install dev pack → restore the captured .fdx via the file chooser → preview shows the
  counts → confirm → collection shows the same grouped tile(s) and the same owned copy ids/notes as before (read via DOM).
- New `instance-lock.spec.ts` (two tabs, see R01).
- Keep all existing specs green at 390×844 and 1280×800 (no horizontal overflow, taps ≥44px on new controls).

## Don't
- NEVER call capture_screenshot or view any image (crashes Anthropic sessions with HTTP 400 and loses the run). Verify UI
  with js()/DOM checks only, browser session `session="mobile-d"`.
- No `git commit`/`push`. Do not start, restart or kill the dev server on 0.0.0.0:3200 (owner-owned). If it is down, report
  it; only if e2e cannot run otherwise, start `cd apps/mobile && npm run dev` in the background ONCE and say so.
- No `vite build`/`next build` needed (except `npm run build` once at the end to confirm production build + PWA still pass).
- Do not edit packages/core, packages/schemas, tools, BRIEF.md, SPEC.md, docs/*.
- Do not copy the real full packs from `.agent/metrics/packs/` into `public/` (the director does the full-pack test).
- No fake data in the UI; capability-driven honest disabled states.

## Verify before reporting
`npm run typecheck && npm run lint && npm test && npm run e2e` from the root (lint: 0 errors). If a failure is inside
packages/core because the core child is mid-work, say so with exact errors. Your own files must be clean.

## Report
`.agent/reports/sonnet-mobile-d-report.md`: per R-item (R01, R02-UI, R04, R05, R06-adapter, R08-UI, R07-UI, R09-client,
R12-note, R13-cheap) → done/partly/not, files, tests/specs proving it, contract deviations, what needs the Mac. Paste gate
excerpts. Under ~250 lines.

## Sol's findings you own (verbatim from .agent/reports/sol-review.md)

R01 — P0 — second writable browser tab silently deletes saved ownership.
Files: apps/mobile/src/platform/sqlite.ts:33–62,76–80; apps/mobile/src/data/bootstrap.ts:20–31.
Why: connection/singleton locks exist only within one page. Independent sql.js snapshots overwrite the same IndexedDB key. E2 lost a successfully saved physical-copy row. Calling web limited/development mode does not make silent personal-data loss acceptable.
Fix: acquire an origin-wide exclusive USER-writer lock before opening storage, hold it for the page lifetime, deny a second writable instance with INSTANCE_LOCK, and test tab close/crash/takeover and reload. A message-only advisory lock is insufficient; use a proven lock/generation protocol. Do not use irreplaceable personal data in the current web build.

R02 — P1 — persistence failure reports an error but permits unsafe retry.
Files: packages/core/src/db/sql.ts:152–157; apps/mobile/src/data/collection-hooks.ts:38–50; apps/mobile/src/lib/errors.ts:39–40.
Why: COMMIT has already occurred before afterCommit fails. The code throws PersistenceError but neither blocks writes nor reopens persisted state. The UI claims FlashyDex reloaded data although no such recovery occurs. E3's manual retry doubles ownership from two to four; retry:false prevents automatic retries only.
Fix: latch a fail-closed persistence/maintenance state, retire in-memory handles, recover/reopen and refetch before reenabling mutations. Reconcile import receipts; do not replay ordinary bulk adds without an idempotency/recovery decision. Inject real IndexedDB quota/save faults as well as adapter failures.

R04 — P1 — native price refresh opens a read-only connection as its writer.
Files: apps/mobile/src/platform/pack-install/native-store.ts:73–87,164–166; apps/mobile/src/platform/app-database.ts:33–42; node_modules/@capacitor-community/sqlite/dist/esm/definitions.js:200–206,587–600,636–667.
Why: openWritableNative calls openReadOnlyNc. The pinned plugin constructs SQLiteDBConnection(..., true, ...) for createNCConnection and explicitly rejects execute/run in readonly mode. This contradicts the source comment claiming NC is read-write. DatabaseSet.canWriteCatalog nevertheless returns true because a function exists. Native price refresh cannot pass writable initialization/DML through this handle.
Fix: implement a proven conformed writable active-file arrangement/native path adapter while preserving backup exclusion and existence checks; keep NC for candidate/read validation. Until proven, advertise pricesOnly:false on native. Verify actual bridge transactions and reopen on iOS/Android. This defect is source-proven; native execution was unavailable here.

R05 — P1 — worker backpressure does not bound decoded memory.
File: apps/mobile/src/platform/pack-install/pack-install.worker.ts:89–103,128–143.
Why: synchronous decoder.push fills pending[] with copied output before flush can wait for acknowledgements or enforce decoded size. E5 accumulated 64 MiB from a tiny input. maxInFlightObserved=4 measures posted messages only and hides the queue. Header/window checking also does not make total output buffering bounded.
Fix: make decoder output production itself backpressured, or feed bounded compressed slices with a proven worst-case expansion/output bound and enforce the byte limit inside emission. Count pending bytes in metrics and test high-ratio/concatenated/oversized frames, cancellation and native process peaks. Never certify the native never-whole-catalog rule from tiny dev-pack metrics.

R06 — P1 — activation journal is not sufficient for boot rollback.
Files: packages/core/src/services/catalog-install.ts:191,215–218,237–242,351–375; apps/mobile/src/platform/app-database.ts:51,97–99; apps/mobile/src/platform/pack-install/native-store.ts:116–128.
Why: the prepared old-current digest/refs are not durably recorded before the two renames; boot recovery marks jobs interrupted then checks presence, not journal/hash truth. E6 marks a previously installed catalog absent instead of restoring its retained previous file. A crash after candidate rename but before USER commit can also leave old receipt/new active bytes unreconciled. hasPrevious is an in-memory Set lost on restart.
Fix: persist a prepared journal before rename, discover previous state from disk, verify active/previous digest+meta against committed receipts on every boot, restore/reopen old state before releasing readers and clean up only after durable commit. Test every rename/commit/reopen/rollback boundary, including first install and disk-full.

R07 — P1 — required refresh/fill-in modes and exact replay are missing.
Files: packages/core/src/services/sync.ts:9–19,31,114–120,310–326,345–369.
Why: incremental and refresh throw UNSUPPORTED_CAPABILITY, so required single-set fill-in/unpublished recheck paths do not exist. prices_only commits catalog then refetches after interruption; pendingBatch is always null. A changed upstream response can replace the first observation before it is captured in USER history. That is not the documented persisted-payload/hash replay, even if identical refetches are idempotent.
Fix: implement the required modes and durable pending payload/hash/generation replay. Preserve the exact first batch across a kill between CATALOG and USER commits. Honest disabled buttons are correct interim behavior, not an owner-approved scope reduction.

R08 — P1 — .fdx backup and restore are unimplemented owner requirements.
File: packages/core/src/services/stubs.ts:11–18.
Why: capability flags are honestly false and all operations reject UNSUPPORTED_CAPABILITY. Director D25 authorizes that representation while unfinished; it does not override BRIEF's full-backup requirement. JSON v1 does not preserve app settings and is not .fdx.
Fix: implement the documented bounded archive/create/preview/safety-copy/restore/recovery protocol and test restore after reinstall with absent/newer catalogs. Do not mark old raw-backup criteria capability-exempt to hide the .fdx gap.

R09 — P1 — manifest trust and SQLite validation fall short of the contract.
Files: packages/schemas/src/manifest.ts:5–18,61–66; packages/core/src/services/catalog-install.ts:84–95,183–187; apps/mobile/src/platform/app-database.ts:64–76; apps/mobile/src/platform/pack-install/installer.ts:81–85,118–136.
Why: production URL validation is prefix-only, signatures are parsed but never verified, downgrade/same-version-different-hash/calendar/cross-field rules are missing. E6 accepted an unknown signature and invalid version/count combination. Candidate validation checks some meta/counts and best-effort quick_check, but not exact bundled migration/schema fingerprint, object allowlist/triggers/views or mandatory FK/integrity checks; quick_check transport errors are swallowed. Manifest text is fully allocated before its cap is checked. SHA checks do work, but a manifest hash alone does not authenticate the publisher or validate a supplied schema.
Fix: centralize semantic validation/trusted origins+redirects, reject unsupported present signatures or verify shipped keys, reject immutable-version drift/downgrades, bound reads while streaming, and require candidate/active schema+integrity+FK/object checks. Unsigned Phase 1 manifests are allowed; ignored invalid signatures are not. Do not describe this as a demonstrated arbitrary-code exploit.

R12 — P2 — performance evidence does not meet the stated acceptance procedure.
Files: packages/core/test/perf.test.ts:47–69; packages/core/src/services/collection-list.ts:171–174.
Why: tests use one warmup/one measurement per query and 5,000 copies, not ten warmups/100 samples/p95 and 10,000 copies. Whole-group IDs use one extra query per displayed group (up to 50), not the documented batched lookup. Node pass is not bridge/device latency. The director correctly labels those numbers Node-only; calling C16 fixed does not close criteria 63–65.
Fix: reproduce the specified sample sizes, giant/many-group cases and p50/p95/max on target devices, batch group-ID lookup, and measure long tasks/input responsiveness during persistence/install. No phone performance numbers are claimed here.

R13 — P2 — platform capability/seam and native submission work remains.
Files: packages/core/src/platform/platform.ts:4–20; apps/mobile/src/platform/app-platform.ts:32–50,67–70,150–162; apps/mobile/src/platform/pack-install/native-store.ts:93–98; apps/mobile/ios/App/App/Info.plist:48–53.
Why: core Platform lacks the required Phase 1 image-cache seam; metadata HTTP always uses fetch rather than the specified explicit native CapacitorHttp path; file pick reads the whole file before maxBytes checking. Native free-space preflight is unknown, not implemented. No app-owned PrivacyInfo.xcprivacy exists under apps/mobile/ios; dependency manifests may supply some declarations, but the final archive/required-reason audit is absent. ITSAppUsesNonExemptEncryption=false is set while SQLCipher is linked and still needs a factual owner review.
Fix: add the specified seam/capabilities, enforce file.size before allocation, prove or honestly disable unsupported storage paths, implement/injection-test native transport, add required app declarations as needed and audit the merged native archive. Do not infer backup exclusion, encryption classification or App Store approval from TypeScript success.


(R03 is closed by the owner: apps/mobile/src/lib/uuid.ts.)
