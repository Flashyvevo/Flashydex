# Opus director report: FlashyDex Phase 1 (Stage 0 / B / C round 1)

Date: 2026-10-30. Director: Claude Opus. All builders ran on claude-sonnet-5-5.
Status: Stage C round 1 was still running when the director's time ran out. The `sonnet-fix` child is in the background; its log is `.agent/sonnet-fix-run.log` and its report will be `.agent/reports/sonnet-fix-report.md`. The second verification loop was NOT run. Everything below was verified before the fix child started, unless a line says otherwise.

## What happened, by stage
- **Contract check:** DATA-MODEL already had everything the brief asked about: catalog keyed by `(language, id)`, the BRIEF variant enum plus `variantDetail`, `unpublished` status for empty sets, nullable `image_url`. API already had pricedCopies/totalCopies ("N of M copies priced"). No correction was needed.
- **Director notes added:**
  - `docs/API.md`: decisions S2–S9, the UI↔data hook surface, and item 11 (`setOfficialCount`).
  - `docs/CATALOG-PACKS.md`: manifest `setIndexUrl`, dev URLs, and backup-excluded storage directories.
  - Full decision log D0–D29 is in `.agent/DIRECTOR-DECISIONS.md`.
- **Stage 0, sonnet-tooling:** ran out of budget, but everything core was verified green by the director:
  - typecheck, lint, tests (48 core, 6 mobile, pytest), build, Playwright 7/7;
  - `ios/` and `android/` were generated;
  - web SQLite was fixed (root cause: sql.js 1.15 wasm vs jeep 2.8 glue; pinned to 1.12.0);
  - `tools/catalog-builder` was proven on swsh3 (1 set, 201 cards, 364 variants, 694 prices; 1,835,008 B raw → 130,901 B zstd-19, ratio 14.0) and on JA SV2a;
  - the pack-install worker and `/dev/pack-test` were proven.
- **sonnet-tooling-fix:** wrote `catalog-packs.yml` and updated `ci.yml` (both YAML-validated), rewrote `scripts/ios-notes.md` as a Mac checklist, and rewrote the README.
- **Stage B, sonnet-data** (P0 and P1 done):
  - schemas, both migration chains and the migrator, DatabaseSet, and Settings/Catalog/Collection/Portfolio/CatalogInstall/Transfer services;
  - all hooks, plus the bundled set index.
  - SyncService and `.fdx` were stubbed (honest UNSUPPORTED).
- **Stage B, sonnet-ui:** built every UX.md §1.1 route and the shared components. It ran out of budget before writing e2e specs or fixing lint.
- **Stage C round 1:** 16 defects, listed in `.agent/review/director/STAGE-C-DEFECTS.md`. Fix brief: `.agent/sonnet-fix-task.md`. While running, the fixer added `sync.ts`, `sync.test.ts`, `snapshot-validation.test.ts` and `import-invalid-rows.test.ts`. None of this is verified by me.

## What was built
- **Routes:**
  - `/`, `/collection`, `/collection/$ownedId`, `/cards/$language/$cardId`, `/custom-cards/$customId`, `/custom-cards/new`;
  - `/sets`, `/sets/$language/$setId`, `/add`;
  - `/settings` plus `catalog`, `data`, `locations`, `about`, `privacy`, `licenses`;
  - `/welcome`, `/welcome/notice`, `/welcome/languages`, `/welcome/sets`, and dev-only `/dev/pack-test`.
  - There is no `/scan` route; Scan is a disabled tab that opens a "coming" sheet.
- **Databases:**
  - `flashydex-user.db`, through user migrations 0000/0001: the identity ledger, custom cards, owned cards, acquisitions, grades, locations, groups and members, scan sessions, price snapshots, annotations, settings, app state, sync state, receipts, installed catalogs, install jobs, pack metrics, and schema migrations.
  - `catalog-<lang>.db`, through catalog migration 0000: sets, cards, variants, latest prices, catalog meta, and schema migrations.
- **Scripts:** `npm run catalog:build -- --lang en --sets swsh3`, `npm run catalog:dev-pack`, `typecheck`, `lint`, `test`, `e2e`, `build`, and `cap:sync`.

## Acceptance status (verified before the fix round)
| Id | Status | Evidence |
|---|---|---|
| 1 | pass (P, manual) | All routes load client-side; 5-slot nav; Scan is `aria-disabled` and opens a sheet |
| 2 | pass (manual) | No horizontal overflow on 16 routes at 390 and 6 routes at 1280 (`scrollWidth <= innerWidth`) |
| 3 | fail | Several controls are 40 px tall (C7) |
| 4 | partial | Dark theme and aria labels present; set tabs have no tab roles (C8); no `<nav>` landmark at 1280 (C9) |
| 5 | partial | 63:88 art box and placeholder render; the "image not loaded" case was caused by C1 |
| 6 | partial | Reload persists in a desktop browser; phone LAN not tested |
| 7 | untested | Needs native |
| 8, 9–12 | pass (V) | portfolio/collection tests (147 core). P8 empty dashboard shows real empty states |
| 13–18 | pass (V); P: fail via C1 | Grouped tile ×2, edit and delete all work in the UI, but the stored snapshot is corrupted on web |
| 19–23 | pass (V); P: partial | Search, confirm sheet (condition "Not set"), qty 2 → one tile |
| 24, 26–32 | pass (V) | catalog-repo and collection tests; set Owned/Missing tabs correct in the UI |
| 25 | partial | Details show prices, source and date; collector number shows `#19`, not `19/189` (C11) |
| 33 | pass (P manual) | Missing list paginated (150 rows after scrolling) |
| 34–36 | fail | SyncService was a stub (C5); the fixer was implementing it |
| 37, 38 | partial (V) | Not audited by name (data report) |
| 39 | pass (V) | tcgdex mapper fixtures |
| 41–48 | pass (V); P: fail | Transfer tests pass; web import dry-run failed (C2) |
| 49–51 (.fdx) | fail / known gap | UI disables the action with an honest reason (C15) |
| 52 | partial | Web Blob download works; native Share untested |
| 53–62 | mostly pass (V) | 147 core tests; per-id audit not done |
| 63, 64 | untested | Perf tests missing (C16) |
| 65 | untested | — |
| 66 | pass (P) | Exact disclaimer in onboarding and About; no trademarks in UI copy |
| 67 | pass | Workspaces build |
| 68 | partial | e2e had 1 failing smoke and no UI specs (C4) |

## Tests, last director run
- core 147/147, mobile 5/5, pytest 1/1, catalog-builder 14/14 (Stage 0).
- e2e: 6 passed, 1 failed.
- typecheck: exit 0.
- lint: 9 errors.

## Known gaps
- **C1, critical:** the web add path stores a column-shifted snapshot. In the stored row, name holds the set name, setName holds "19", localId holds the rarity, rarity holds the image URL, and imageUrl holds the string "undefined".
- **C2:** web import dry-run fails with a generic error.
- `.fdx` backup/restore is not implemented.
- SyncService: unverified.
- Perf tests: missing.
- Native, iOS-only items are untested: NoCloud backup exclusion, `createNCConnection`, free space. The SQLCipher export-compliance answer needs the owner's review (`scripts/ios-notes.md`).
- The `/welcome/languages` counts come from the set index, not the manifest (C10).

## Process notes for the owner
- **Port 3200:** the dev server (PID 12424 on 0.0.0.0:3200, started by sonnet-ui) is still running. This unattended session cannot force-kill processes (the approval gate blocks `taskkill /F`). Stop it by hand. The stale PID 22752 had already exited.
- **Rerun Stage C:** when the fix child finishes, rerun Stage C. Check `npm run lint`, `npm run e2e`, and add a card in the browser to confirm the tile shows "Charizard V".
- **Nothing committed:** docs/API.md and docs/CATALOG-PACKS.md were changed only by appending dated Director notes.

## What to try first on the phone (after C1 is fixed)
1. `npm run dev`, then open `http://<pc-ip>:3200`.
2. Go through first run: Get started → Continue → Continue → Start download. "English catalog ready" should appear.
3. Add → search "Charizard" → Add 2 copies. The Collection should show one tile ×2 with the correct name and art.
4. Edit one copy (NM, paid), then reload. The edit should persist.
5. Settings → Import, export & backup → Share JSON.
