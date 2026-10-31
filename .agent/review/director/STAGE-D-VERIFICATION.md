# Stage D verification — Claude Opus director (2026-10-31)

All checks by the director, DOM/CLI only (no screenshots), browser session `director`, viewport 390×844 (mobile emulation),
dev server 0.0.0.0:3200 (owner-owned, PID 20868). Code state: after sonnet-core-d + sonnet-mobile-d, before sonnet-fix-d.

## Gates (director run)
| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0 (core, schemas, mobile) |
| `npm run lint` | exit 0 — 0 errors, 21 warnings (pre-existing react-refresh) |
| `FLASHYDEX_SKIP_PERF=1 npm test` | exit 0 — core 268 passed / 6 skipped (perf) in 21 files; mobile 16/16 (5 files); pytest 1/1 |
| core `test/perf.test.ts` alone | 6/6 (10 warm-ups, 100 samples, 10k copies; Node only) |
| `npm run e2e` | exit 0 — 18/18 (mobile + desktop; incl. new instance-lock, persistence-failed, backup→fresh-context→restore) |
| `npm run build` | exit 0 — PWA precache 60 entries |
| tools/catalog-builder `npm test` | 24/24 |

## Real full EN pack through the UI
Setup: copied `.agent/metrics/packs/catalog-{en,ja}-2026.10.31.001.db.zst` + set indexes into a temporary
`apps/mobile/public/dev-packs-full/` and pointed the dev manifest at it (same origin, so it passes the DEV trusted-origin
rule). Both were reverted/removed afterwards (`git status apps/mobile/public` clean).
- Fresh origin (Storage.clearDataForOrigin) → welcome → notice → languages → sets → Start download: "English catalog ready"
  ~6 s after start (12.3 MB → 138 MB). JS heap after: 193 MB used (web keeps the DB in memory — known web limitation).
- IndexedDB `jeepSqliteStore/databases`: `catalog-enSQLite.db` = 138,002,432 bytes; SHA-256 of the stored bytes =
  `bbca47b37ae46b73684ea784abb8c96ac9bba98b5317512cb6841285ec081606` = manifest sha256. The same bytes' `catalog_meta`
  (read from the source raw DB with better-sqlite3): language en, version 2026.10.31.001, schema_version 1,
  sets 220 / cards 23736 / variants 36693 / prices 48805 / unpublished 4, schema_fingerprint 9157e30e….
- `/settings/catalog`: "Catalog 2026.10.31.001 · about 132 MB on this device".
- Search on `/add`: "Pikachu" → 30 result rows (page size); "Umbreon VMAX" → Evolving Skies 214/203, 215/203, 95/203,
  Brilliant Stars TG23. "Charizard" → 30.
- Added Umbreon VMAX 214/203 ×12 and Pikachu (McDonald's 2014) ×1 through the confirm sheet → collection shows
  "×12 · Holo · Umbreon VMAX" and the Pikachu tile.

## Corrupted pack → old catalog survives
Copied the EN .zst to `…2026.10.31.002.db.zst`, flipped one byte at offset 6,000,000 (0x27 → 0x5a), manifest EN
targetVersion 2026.10.31.002 (sha256 unchanged). `/settings/catalog` → Check for updates → "Update · 11.8 MB" → result:
"The download was damaged and wasn't installed. Your current catalog is unchanged." Store keys afterwards:
`catalog-enSQLite.db, flashydex-userSQLite.db` only (no candidate/previous leftovers), stored EN SHA still `bbca47…`,
search "Charizard" still 30 rows, collection tiles unchanged.
- DEFECT D1 (UI, → fix-d F1): the failure is shown under the JAPANESE row and its button becomes "Retry"
  (`catalog-download-ja`), while the English row still says "Update · 11.8 MB".

## .fdx backup → wipe → restore (reinstall simulation)
- `/settings/data` at 390: scrollWidth 390 = innerWidth. `backup-create` 358×131, `restore-file` 358×76, both enabled
  (no aria-disabled).
- Export JSON (before) + Back up now → `flashydex-20261031T060444Z.fdx` (2,249 bytes). `unzip -l`: manifest.json,
  entities.json, settings.json; manifest counts ownedCards 13, priceSnapshots 2, catalogIdentities 2.
  DEFECT D2 (→ fix-d F2): manifest `"catalogs":[]` although EN was installed (no informational version hint).
- Wipe: Storage.clearDataForOrigin (all storage) → reload → full onboarding → full EN pack reinstalled → collection 0 tiles.
- Restore: Restore from backup… → sheet → Choose backup file (input accept `.fdx,application/vnd.flashydex.backup+zip,…`)
  → preview dialog: "Restore this backup? / Replaces all personal data / Backup: 13 cards / Now: 0 cards / 13 owned copies /
  2 saved prices / Catalog: 2 cards match your installed catalog." No overflow (390). Confirm button disabled (280×48)
  until "RESTORE" typed → enabled → "Backup restored — 13 cards. A safety copy … flashydex-20261031T060538Z.fdx".
- Export JSON (after) vs before (`.agent/review/director/compare-exports.mjs`): ownedCards 13/13 IDENTICAL,
  priceSnapshots 2/2 IDENTICAL, all other personal arrays (empty) identical → "ALL IDENTICAL" (same UUIDs, same fields).
  Rich grade/acquisition/location/group/custom round-trips are covered by core `test/backup.test.ts`, not by this UI run.

## Second tab → instance lock (R01)
- `Target.createTarget` second tab at 390 while the first tab is open: full-screen `instance-lock`: "FlashyDex is open in
  another tab / Close the other tab, then reload this one. / Reload" (93×48), no overflow.
- Closed the first tab → the second tab took over within ~3 s, collection shows the restored 13 copies, no
  `writes-blocked` banner.
- Insecure origin `http://10.0.0.4:3200` (isSecureContext false, navigator.locks absent): `writes-blocked` banner
  "Editing is off: this browser can't guarantee only one FlashyDex tab writes. Open FlashyDex over https or on localhost."
  CONSEQUENCE (owner ruling D42): the phone-over-LAN-HTTP test is now read-only, onboarding included. Phone testing needs
  https (mkcert) or Chrome USB port-forwarding to localhost:3200.

## Sync refresh (R07) live
`/sets/en/swsh7` → More actions → "Refresh this set" (enabled) → pill "Downloading cards · 0 % … 84 %" → "Cards updated"
in ~10 s against live api.tcgdex.net. Set page still "1 of 237 cards · 11 duplicates" (owned rows untouched).

## Not verifiable here
Native (R04 writable catalog, native stage/activate/inspect, backup exclusion, PrivacyInfo target membership, memory peaks),
real IndexedDB crash between jeep's remove and put (→ fix-d F3), phone LAN.

## Re-verification after sonnet-fix-d
- Gates: typecheck 0; lint 0 errors / 21 warnings; `npm test` core 275/275 (incl. perf), mobile 22/22, pytest 1/1;
  `npm run e2e` 20/20 (new `catalog-failure.spec.ts` covers D1 on both projects); `npm run build` 0; catalog-builder 24/24.
- D1 fixed (EN failure now on the EN row; JA row untouched) — e2e evidence, not re-walked by hand.
- D2 fixed — core test `backup.test.ts` "manifest carries informational catalog version hints".
- F3 jeep atomic save: on disk all shipped copies patched (`patches/jeep-sqlite+2.8.0.patch`, postinstall patch-package);
  production `dist/assets/jeep-sqlite.entry-*.js` has `saveDBToStore` = single `setItem`. The RUNNING dev server still serves
  the unpatched module from its transform cache (`/@fs/.../jeep-sqlite/dist/esm/jeep-sqlite.entry.js?v=7f94cc82` contains
  `removeItem` first) → the owner must restart the dev server for the patch to apply in dev.
