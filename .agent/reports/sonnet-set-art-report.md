# sonnet-set-art report

Status: all gates green. Nothing committed, no `npm install`, no full pack build, dev server :3200 untouched. Scanner-owned files untouched.

## Part A — builder (`tools/catalog-builder`)
- New `src/set-art.ts` (+ `test/set-art.test.ts`, 7 tests); wired in `src/cli.ts` (after crawl, skipped by `--no-asset-check`) and `src/build-db.ts` (`setArt` input, additive).
- Per set without a native logo, first hit wins:
  1. probed `{lang}/{serie}/{id}/logo.webp` then `logo.png` -> `logoSource: 'tcgdex'`
  2. JA only: EN twin logo from the hand-written `JA_TO_EN_LOGO` table (79 JA ids -> exactly one EN id each; used only if that EN logo itself probes 200) -> `'en-twin'`
  3. probed symbol (JSON symbol rewritten to the language, then `symbol.webp|png`) -> `'symbol'`
- Probe rule: exact HTTP 200 on HEAD; errors/404 = absent. No URL is written that wasn't probed (native JSON logos are kept as before, unprobed).
- Provenance in `catalog_sets.raw_json.logoSource` (`tcgdex|symbol|en-twin|null`); the set-index JSON carries the resolved `logoUrl`. No schema change, no migration.
- Metrics JSON: `setLogoCoverage { sets, withLogo, withSymbol, byProvenance{tcgdex,symbol,en-twin,none} }` (camelCase to match the other metrics keys, not literally `set-logo-coverage`).
- Auto-matching JA->EN by series/official count/date was tried on the cached data and rejected (all 15 `CS*` sets collide with bw3/ex5; S3/S4/S8 -> dp5/ex2). Hence the explicit table.
- Gotcha: TCGdex serves `.../logo` (no extension) as 200 text/html; only extensioned URLs are probed, so that can't leak in.

### Coverage achievable (cached set details of pack 2026.10.31.001 + live HEAD probes, through the real `resolveSetArt`)
- EN, 220 sets: 157 native -> **163 with logo**. Of the 63 null: 1 alternate logo (`30th`, logo.png), 5 symbol (`ex5.5 exu mep sma sv05`), **57 none** (53 published, 4 unpublished shells `jumbo rc sp wp`).
  Still none (published, rely on cover card): 2011bw 2012bw 2014xy 2015xy 2016xy 2017sm 2018sm 2019sm 2021swsh 2022swsh 2023sv 2024sv 30th-c A3a A3b B1a B2a bog cel25cc mee mfb miscp sm3.5 sm7.5 sve svp swsh10tg swsh11tg swsh12.5gg swsh12tg swsh4.5sv swsh9tg, the 20 tk-* trainer kits, xya.
- JA, 184 sets: 0 native -> **76 with logo**: 1 alternate (`M4`) + 75 en-twin. **108 none** (64 published; 44 unpublished shells the app never lists).
  Still none, published (cover card): CP2 E1 E2 E3 E4 E5 M-P M6 MC neo1 neo2 neo3 neo4 PCG1-PCG9 PMCG1-PMCG6 S10a S11a S8b S9a SM10a SM10b SM11a SM11b SM12a SM1p SM2p SM3p SM4p SM5p SM6a SM6b SM7a SM7b SM8a SM8b SM9a SM9b SV-P SV1a SV3a SV5a SV5K SV5M SV7a SV8a SV9a SVK SVLN SVLS VS1 web1.
  (SV5K/SV5M map to EN sv05, which itself has no logo, so they get nothing.)
- Dry runs (real CLI, scratch out dir; the CLI has no `--limit-sets`, `--sets` used): `--lang en --sets 30th,sv05,mep,swsh3` -> tcgdex 2 / symbol 2; `--lang ja --sets M4,SV3,SV5K,CP2` -> M4 tcgdex, SV3 en-twin (`en/sv/sv03/logo.webp`), SV5K + CP2 none. DB rows and `raw_json.logoSource` checked.

## Part B — app
- `SetLogo` (same name; `set` now `{id, language, name?, logoUrl, symbolUrl?}`) renders tiers: logo (contain) -> symbol (centered, max 3/4 x 3/5) -> **cover card** (`low.webp`, `object-cover`, `object-position 50% 20%`, bottom gradient; `showName` overlay prop, unused today because Sets tab / picker / header all have an adjacent name) -> id chip. `onError` advances one tier; never a broken icon. Fixed boxes: 56x32, header 240x80. `data-testid="set-art"` + `data-tier`.
- `set-picker.tsx` now uses `SetLogo` (its duplicate inline tile removed), so onboarding and Settings -> Catalog pickers are covered. Sets tab and set header use it with no call-site change.
- Data: `CatalogRepo.setCovers(language, ids)` in `packages/core/src/services/catalog.ts` (read-only, additive) + `useSetCover(language, setId, enabled)` in `catalog-hooks.ts` (exported from `data/index.ts`, key `['fd','setCover',lang,id]`).
- Query cost: one statement per <=100 sets: `SELECT s.id, (SELECT image_url ... ORDER BY local_id_sort, id LIMIT 1) FROM catalog_sets s WHERE language=? AND id IN (...)`. Plan: `SEARCH c USING INDEX cc_set_sort (language=? AND set_id=?)` per set, i.e. O(sets), no card scan. Tiles mounting in the same ~16 ms window are coalesced per language (200 tiles -> 2 statements, not 200); a tile only asks once within 200 px of the viewport and only when no logo/symbol tier is left. Cached in react-query (`staleTime: Infinity`); dropped by `invalidateAll` (catalog change), not by personal writes. Not timed on a full pack (the `dist/` DBs hold 1 set each); the query plan is the evidence.
- Not covered: onboarding picker before any catalog is installed reads the bundled index, so a null-logo set shows the id chip there (no card data exists yet).

## Gates
- `npm run typecheck`: pass. `npm run lint`: 0 errors (23 pre-existing warnings).
- Builder vitest 34/34 (7 new). Core vitest 383/383 (3 new `setCovers` tests in `packages/core/test/catalog-repo.test.ts`). Mobile vitest 469/469.
- Playwright, `FLASHYDEX_E2E_PORT=3213`, mobile + desktop projects: `sets-art.spec.ts` + `routes.spec.ts` + `core-flow.spec.ts` = 8/8 passed.
  `sets-art.spec.ts` (new): swsh3 tile has an `<img>` with `assets.tcgdex.net/.../swsh3/.../logo.webp` -> logo requests 404'd by route mock -> same tile becomes `data-tier=cover` with a loaded `.../low.webp` img (`object-fit: cover`) -> all assets 404'd -> `data-tier=chip`, text `swsh3`, zero `<img>`. The mocked-null-logo case is a mocked logo 404, not a DB row with null `logo_url` (the dev pack only has swsh3).
- Measurements (same spec, 375/390/430 px on `/sets?show=all`, `/sets/en/swsh3`, `/welcome/sets` picker): `scrollWidth - innerWidth <= 0` everywhere; every `set-art` box exactly 56x32 (240x80 on the header); no tiles stuck in `loading`; no broken images. Layout shift was checked as fixed box sizes, not with a CLS observer.

## Open risks
- `JA_TO_EN_LOGO` comes from my knowledge of the JP/EN releases, not machine-verified; borrowed EN logos carry English wording on JA sets. Worth a quick eyeball, especially `S8a->cel25`, `CP6->xy12`, `XY10->xy10`, `XY11a/b->xy11`, `M5->me05`. Delete a line to drop an entry.
- New logos only appear in the next pack the director builds; installed packs keep theirs (cover cards cover the gap meanwhile). `30th`'s PNG logo is 219 KB on a 56x32 tile (lazy, one set).
- A native TCGdex logo that 404s at runtime now falls to symbol/cover (before: an empty gray box).
- `docs/UX.md` also holds another agent's uncommitted Live Scan section; my change there is the single "Set art tiers" bullet under 6.1. `docs/CATALOG-PACKS.md` got one paragraph after the pipeline list.
- Throwaway scripts: `.agent/scratch/set-art-*`, `doc-ins.mjs`; dry-run output under the Hermes scratch dir.
