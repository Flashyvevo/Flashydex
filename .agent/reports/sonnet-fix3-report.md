# sonnet-fix3 report — FlashyDex Phase 1, Stage C round 2b

Method: Playwright Chromium (node script, no screenshots), 390×844 isMobile+touch, fresh profile, real onboarding + dev-pack install + add Charizard V ×2.
Probe: `.agent/scratch/probe-layout.mjs <out.json>`; helpers `diff.mjs`, `diff-overlaps.mjs`, `summarize.mjs`; raw runs `before-390.json` (original code), `before2-390.json` (original behaviour re-created by moving the base rules into a layer declared after `utilities`), `after7-390.json` (final), `diff-final.txt` (176 lines).
Note: the dev server on :3200 had died by the time I made my first CSS edit (connection refused, no listener); I restarted it once with `npm run dev` (background, pid 12248) — only one instance exists.

## The change
1. `apps/mobile/src/styles/globals.css`: body, `button,a,[role=button],nav,.no-select` (user-select/touch-action), `img`, `:focus-visible`, `[tabindex="-1"]:focus(-visible)` (kept after `:focus-visible`), body margin/min-height, `h1,h2,h3,p {margin:0}`, `input,select,textarea,button {font/color inherit}`, `button {background:none;border:0;padding:0;cursor:pointer}` are now inside `@layer base`. `.sr-only .tabular .selectable .scroll-hide .tile-grid` etc. untouched (unlayered). tokens.css untouched.
2. Consequence found by the probe: utilities that were silently dead now apply, and where a component and its caller both set the same property (`px-5` default vs caller `px-3`), Tailwind's CSS ordering — not authorship — picks the winner. Fixed at the components:
   - `ui.tsx` `Button` / `LinkButton`: defaults for min-h / px / py are dropped when `className` supplies its own (`buttonBox()` helper). Callers' `px-3`, `px-1`, `px-4`, `min-h-*` now win as written.
   - `ui.tsx` `SegmentedControl`: `tabs` variant uses `px-1` (was `px-3`), otherwise "Missing 200" etc. got ellipsized on /sets/en/swsh3 (regression the probe caught).
   - `routes/_tabs/collection/index.tsx`: Filters button `px-2`, Sort button `px-1.5` (was `px-3`) so "Recently added" is not ellipsized next to the view toggle (probe: sw 120 / cw 122, no clip).
3. fix2's `px-4!`/`py-2!` removed from CardRow (card.tsx), NavRow, ActionRow (ui.tsx) + stale comment. Re-probe: zero rect/color/bg differences vs. with them (diff after6→after7 = only the "Last checked" timestamp text).

## Three symptoms (390×844)
1. Disabled rows: `backup-create` / `restore-file` computed `cursor: not-allowed`, background `oklab(0.235 -0.0012 -0.0184 / 0.6)` (bg-surface-2/60); enabled `export-json` / `export-csv` stay `pointer` / transparent. aria-disabled=true on the two disabled rows.
2. Copy-editor Save: 37×44 → 61.9×44 (padding 0 12px). Colour rgb(255,203,5) accent when dirty (after tapping NM); rgb(79,86,104) `fg-disabled` while pristine (correct `disabled:` styling).
3. C7 offenders (visible button/a/[role=tab|button|switch]/input/select <44, links in `<p>` exempt): `[]` on /, /collection, filter sheet, /add, /add results, /add confirm sheet, /sets, /sets/en/swsh3, /cards/en/swsh3-19, copy-editor sheet, /settings, /settings/data, /settings/catalog, /settings/locations, /collection/<owned> (= /cards/en/swsh3-19?variant=holo), tab bar. (Before: exactly one — copy-save 37×44.)

## Round-2 re-confirmation (final run)
- P1: Scan "Soon" label top 830 ≥ circle bottom 828, bottom 842 ≤ innerHeight 844.
- P2 (title x-range vs back x-range, none intersect): /settings/data 96–294 vs 4–48; /settings/catalog 128–262 vs 4–106; /settings/locations 123–267 vs 4–48; /sets/en/swsh3 126–264 vs 4–77; /cards/en/swsh3-19 146–244 vs 4–120; /collection/<owned> 146–244 vs 4–120. (Back buttons grew by their own `pr-3` now that padding applies; titles unchanged.)
- P4: lang chip tops 122/122/122; result thumbnails x = 16, 16.
- P5: sheet heading H2 tabindex=-1 outline-style none; Tab-focused "Holo" button outline solid 2px.
- scrollWidth == innerWidth (390) on all 16 probed screens; 1280 covered by e2e `routes.spec` (desktop project, scrollWidth ≤ innerWidth on 18 routes) – green.
- Overlap check (interactive elements overlapping, before vs after, name-pair level): no new overlaps except `card-menu × copy-save`, which is the page header behind the sheet (copy-save now 62 wide instead of 37), not visible overlap. Clipped-text check: no new clips after fixes (remaining clips are pre-existing: tile subtitle, bar titles with ellipsis by design).

## Before/after diff — verdicts (176 lines; grouped, tab-scan etc. listed once)
INTENDED (author's utility now applies; rect moved only because of it):
- All `<button>` variants: bg/colour/padding from Button/BUTTON_STYLES now render. Primary: `add-submit`, `add-copy`, `filter-apply`, `missing-add` ×29, `import-file`, `catalog-download-ja` (117 w, was 76), `prices-update`, create-location → accent bg + on-accent text, px 20. Secondary: `filter-button`, `sort-button`, `Load more` → surface-3 bg. Text/ghost: `sheet-cancel`, `Reset`, `Other…`, `Select` (px 12, 72 w), `card-menu`, `set-menu`, `back-button` (accent colour, pr 12), `dash-update-prices` (accent, px 4, h 48→44 = its own `min-h-(--ps-tap)`), `copy-delete` (negative colour).
- SegmentedControl (`lang-*`, `view-*`, `show-*`, currency/search-lang, USD/EUR toggles, set tabs): selected = fg bg + bg text, unselected muted, px 12 (tabs px 4); chips `filter-cond-*`, `copy-cond-*`, `variant-chip-*`, `condition-chip-*` py 4. Widths of `show-collecting`/`show-all` 60→68, USD/EUR 44→53.
- Tab-bar Scan FAB: bg-surface-3 + fg-disabled icon + shadow (was transparent, white icon).
- `p` with `mt-1`/`mt-*` (home "Add what you paid…", confirm "Market $7.15", filter "Prices in…"): margin 4 → content below shifts +4 px (home: 174→178 … recent tiles 636→640). Intended spacing.
- `copy-row` (card detail): px 16 / py 8 now applied, y −4 (row min-h unchanged).
- Switch rows (`filter-dupes` 48→58, `filter-hide-pocket` 60→76, `pocket-switch`, `graded-switch`): `py-2` now applies; only multi-line rows grew; no clip/overlap. Intended (author wrote py-2, min-h kept).
- `backup-create` / `restore-file`: the P3 fix itself.
- `copy-save` 37→62 wide: C7 fix itself.
REGRESSIONS found and fixed at the component (listed above): Button caller-override conflicts (Filters/Sort/dashboard Update prices/Settings Reset), SegmentedControl tabs ellipsis ("Missing 200"), sort label ellipsis ("Recently added").
Noise: "Last checked …" timestamp text key changes (not layout).

## Final commands (repo root)
- `npm run typecheck` — clean (core, schemas, mobile).
- `npm run lint` — 0 errors, 21 warnings (unchanged, all react-refresh/only-export-components).
- `npm test` — core vitest 169/169 (14 files), mobile vitest 9/9 (3 files), recognition pytest 1/1.
- `npm run e2e` — 12/12 passed (mobile 9, desktop 3).
- No commits, no tokens.css/schema/docs edits. Files touched this round: globals.css, ui.tsx, card.tsx, collection/index.tsx; scratch under `.agent/scratch/` (probe, JSON runs, diffs, `globals.after.css` copy).

## Caveat
Rendering was judged from DOM measurements only (no screenshots). The visual look of the now-applied button fills/paddings (e.g. filled primary buttons, filled FAB) is the biggest visible change from what the owner saw — worth a human look on-device.
