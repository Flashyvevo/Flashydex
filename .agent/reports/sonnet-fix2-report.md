# sonnet-fix2 report — FlashyDex Phase 1, Stage C round 2

Notes on method
- The dev server that was supposed to be running on :3200 was NOT running (connection refused, no listener). I started one (`npm run dev`, background) — the only one; I did not kill anything.
- The `browser_exec` session `fix2` hung forever in "Opening your collection…" (fdx:db-open never returned, sql-wasm never fetched) on its persistent profile, even for a fresh tab. A clean Playwright Chromium on the same server opens in ~40 ms. So ALL DOM measurements below were taken with Playwright (390×844, dSF 1, isMobile+touch, fresh profile + real onboarding/dev-pack install), no screenshots/images viewed. The probe scripts were deleted afterwards.
- Root cause found for P4b/P5 class of bugs: globals.css has UNLAYERED rules (`button { padding:0 }`, `:focus-visible { outline… }`) that beat Tailwind's layered utilities (`px-4`, `outline-none`). Fixed locally (see items). The global `button{padding:0}` reset is still there, so any other `<button class="px-*">` still has 0 padding (e.g. non-`full` Buttons); not touched because nothing else was flagged and those layouts were praised.

## Items (status → files → evidence)

P1 tab-bar Scan label — FIXED. `components/shell.tsx` ("Soon" label now absolutely placed at the bottom of the centre slot, `leading-none`, testid `tab-scan-label`).
  At 390×844: circle top 768 / bottom 828; label top 830 / bottom 842 (left 156, right 234); innerHeight 844, innerWidth 390 → label.top ≥ circle.bottom ✓, inside viewport ✓. Other tab labels at 816–834 (x ranges don't overlap label). aria-label kept: "Scan, coming in a later update".

P2 sub-page header collision — FIXED. `components/page.tsx`: header is a 3-col grid `[1fr auto 1fr]`; title `min-w-0 max-w-[60vw] overflow-hidden text-ellipsis whitespace-nowrap`; back label collapses to the chevron when title+label > 24 chars; back button has testid `back-button`, title `bar-title`.
  Rects (x-ranges), none intersect, all titles computed `text-overflow: ellipsis / overflow-x: hidden / white-space: nowrap`:
  /settings/data  title 96–294 ("Import, export & backup"), back 4–48 (label collapsed)
  /settings/catalog title 128–262, back 4–94
  /settings/locations title 123–267, back 4–48 (collapsed)
  /sets/en/swsh3  title 126–264, back 4–65
  /cards/en/swsh3-19 title 146–244, back 4–108
  /collection/<owned id> title 146–244, back 4–108
  (ModalPage header (✕ + centred title, `inset-x-16 truncate`) was left as is — not a sub-page back header.)

P3 export/backup rows — FIXED. New `ActionRow` in `components/ui.tsx` (leading icon tile, label+description, trailing icon, min-h 56, pressed state, `aria-disabled`, disabled styling + "Later build" badge); `routes/_tabs/settings/data.tsx` uses it in a `Group` for Share JSON / Share CSV (trailing share icon) and Back up now / Restore from backup… (disabled → muted bg, `cursor-not-allowed`, "Later build" pill, `aria-describedby=backup-reason`). Existing testids kept.
  Measured: export-json h 60 w 358, 2 icons, aria-disabled null; export-csv same; backup-create & restore-file aria-disabled="true", 1 icon, text ends "Later build"; row padding 16px (iconX 32 inside row at 16).

P4 /add filters + thumbnails — FIXED. `routes/_modal/add.tsx`: language is one full-width `SegmentedControl` (All | EN | JA, testids lang-all/en/ja) above a full-width set select. `components/card.tsx` CardRow: `px-4! py-2!` (unlayered button reset was zeroing padding → thumbnail at x=0).
  (a) lang tops: all=122, en=122, ja=122 (widths 118 each). Set select y 177, w 356.
  (b) result-row thumbnails: img/art x = 16 for every row (before: 0).

P5 focus ring on headings — FIXED. `styles/globals.css`: `[tabindex="-1"]:focus, [tabindex="-1"]:focus-visible { outline: none }` (unlayered so it beats the generic `:focus-visible` rule; Tailwind `outline-none` was layered and lost). Measured after opening the confirm sheet: activeElement = H2 "Charizard V" tabindex=-1, `outline-style: none`. Controls keep the `:focus-visible` ring.

P6 startup timing — DONE (a,b,c). `packages/core/src/perf.ts` (`timed()` → performance.mark/measure, no-op without Performance API), exported from core; wrapped: `fdx:gate-total`, `fdx:db-open`, `fdx:services`, `fdx:migrate-user`, `fdx:recover-install`, `fdx:recover-sync`, `fdx:catalog-open-<lang>` (core `services/index.ts`, `db/database-set.ts`; app `data/bootstrap.ts`). One dev-only `console.info("[fdx] startup …")` line. There is no catalog "migrate" step on open (read-only handle), so no `fdx:migrate-catalog`; `fdx:catalog-open-*` covers the catalog open.
  Measured (clean Chromium, installed swsh3 catalog, 3 hard reloads): gate-total 49 / 30 / 36 ms (db-open 32/17/23, services 17/13/13, migrate-user 5/4/6, recover-install 11/8/7, recover-sync 0); route content visible 397/332/334 ms after navigation. First load of a fresh profile: gate-total 274 ms.
  (b) Duplicates: user DB opened once per load (single `fdx:db-open`); catalog en opened once (`fdx:catalog-open-en` ×1 = 21 ms, ja = null/1 ms) after a full /add search. No double read found, nothing to fix.
  (c) In-app navigation (Home→Collection→Sets→Settings→Home): "Opening your collection…" never appeared (MutationObserver count 0) and no new startup log.
  The 5–10 s the owner saw is NOT reproduced here; the one environment that hung (browser_exec persistent profile) hung before any wasm fetch, i.e. inside jeep-sqlite web-store init — worth re-measuring on the owner's profile with the new `[fdx]` line.

P7 pluralization — FIXED. `plural()` already existed in `lib/format.ts`; now used for: set detail ("1 duplicate", "N cards"), collection count fallback, set picker card counts, catalog "N sets"/"Stopped at N cards"/progress line, dashboard "known cost on X of N cards". Measured set detail: "1 of 201 cards / 200 missing · 1 duplicate". Existing uses (copies, rows, imported cards) already went through `plural`.

P8 confirm-sheet art — FIXED. `CardArt` gained `lowFirst` (card.tsx): renders the cached low.webp immediately underneath, high.webp fades in over it; placeholder only if both fail; box stays 63:88. Used in `add-confirm.tsx`. Measured: `card-art-low` present at open, complete=true, naturalWidth 245; art 112×156.4 (ratio 0.716 = 63:88), data-art-state loaded. (Timing of the swap on a throttled network was not separately measured.)

C4 e2e — FIXED. `playwright.config.ts`: projects `mobile` (390×844, isMobile, hasTouch, dSF1) and `desktop` (1280×800; ignores pack-install which is viewport-independent and runs once on mobile); reuseExistingServer true. `e2e/helpers.ts` (trackErrors, onboardAndInstall, openConfirmFor), `sqlite.smoke.spec.ts` (fresh profile → /welcome, DB opens, no errors), `core-flow.spec.ts` (onboarding → install → search Charizard → Charizard V → qty 2 → Add → ONE tile with ×2 → detail shows Darkness Ablaze + 19/189 + "copies valued" → /settings/data Share JSON downloads JSON containing "Charizard V"), `routes.spec.ts` (18 routes incl. /welcome*, console/pageerror = none, scrollWidth ≤ innerWidth). The route test caught a real bug: React warned `fetchpriority` → fixed to `fetchPriority` in `card.tsx` (removed the ts-expect-error).

C16 perf — FIXED. `packages/core/test/perf.test.ts`: 40,000-card synthetic catalog (200 sets × 200) via the core test harness (node SQLite), real `catalog.searchCards` with the same query shapes /add builds, warm-up then timed; plus 5,000 owned rows (50 bulkAdd×100) and `collection.list` grid/sorts/filter. Measured: search "char" prefix 18 ms (12,000 matches), "pikachu" 8 ms, "char" contains 26 ms, number "19" 10 ms, "charizard"+number 5 ms; collection grid 20–29 ms. All < 300 ms; file runs in ~5 s. (Node SQLite, not the phone — device numbers still need the Mac.)

Pill wording — FIXED. `components/sync.tsx`: the visible pill already said "Updating prices…" for prices_only, but the screen-reader live region always announced "Catalog download started". Running states now carry their own `start` text ("Updating prices" for prices_only), and a finished update shows a 3 s "Prices updated" pill (new transition detector). Measured with TCGdex requests delayed 4 s: pill "Updating prices · 0 %", live region "Updating prices" → then "Prices updated" (pill + live region), then gone.

C7 touch targets — VERIFIED, no offenders. Every visible button/a/[role=tab|button|switch|radio|checkbox]/input/select (<44 px test) on /, /add, confirm sheet, /cards/en/swsh3-19, /collection, filter sheet, /sets, /sets/en/swsh3, /settings/data, /settings/catalog, /settings/locations: offender list `[]` for each (hidden full-size `<select>` overlays measured via their 46 px wrapper).

C13 — VERIFIED. /sets row: "Darkness Ablaze EN 1 / 201 · <1% · 1 extra".
C14 — VERIFIED. One copy: "1 of 1 copy valued"; two copies: "2 of 2 copies valued".

Extra fix (same root cause as P4b): `NavRow` button variant (`ui.tsx`) had 0 padding — label flush against the group edge ("Sets I collect"); now `px-4! py-2!` (label x 16 → 32).

Lint — PARTLY. 22 → 21 warnings, 0 errors. Fixed the `react-hooks/exhaustive-deps` one (`sets/index.tsx` `followed` memoised). The remaining 21 are all `react-refresh/only-export-components` (components files also export hooks/helpers/constants); fixing means splitting ~12 files and rewiring imports — not "cheap/safe", and I did not disable the rule.

## Final command outputs
- `npm run typecheck` — clean (core, schemas, mobile).
- `npm run lint` — 0 errors, 21 warnings (all react-refresh/only-export-components).
- `npm test` — core vitest 169/169 (163 + 6 new perf tests), mobile vitest 9/9, recognition pytest 1/1. catalog-builder (separate workspace) 14/14.
- `npm run e2e` — 12/12 passed (mobile 9, desktop 3), 0 failed. mobile = pack-install ×6 + sqlite.smoke + core-flow + routes; desktop = sqlite.smoke + core-flow + routes (pack-install intentionally ignored on desktop).
- Dev server: one Vite on :3200 started by me (background process), left running.
- Uncommitted new files: apps/mobile/e2e/{helpers,core-flow,routes}.spec/ts, packages/core/src/perf.ts, packages/core/test/perf.test.ts, this report. No commits, no schema/migration/tokens.css/docs edits.
