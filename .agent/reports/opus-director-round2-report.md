# Opus director report: FlashyDex Phase 1, Stage C round 2

Date: 2026-10-30. Director: Claude Opus. Two children ran, both on claude-sonnet-5-5:
- sonnet-fix2: brief `.agent/sonnet-fix2-task.md`, report `.agent/reports/sonnet-fix2-report.md`
- sonnet-fix3: brief `.agent/sonnet-fix3-task.md`, report `.agent/reports/sonnet-fix3-report.md`

Nothing is committed. 22 files are modified and 5 are new (see `git status`).

## Per-item results
"Director" means I measured it myself at 390×844 with DOM checks in browser session `director`, on the final code after fix3. "Child" means the evidence comes from a child's own measurement.

| Item | Status | Evidence |
|---|---|---|
| P1 Scan label clipped | fixed | Director, on all 8 tab routes: circle spans y 768–828 and the "Soon" label spans y 830–842 (x 156–234). Viewport is 844 high. The label sits below the circle and inside the viewport. aria-label is "Scan, coming in a later update". |
| P2 Sub-page header collision | fixed | Director, title x-range vs back x-range, none intersect, every title has ellipsis/hidden/nowrap: /settings/data 96–294 vs 4–48 (back label collapses to the chevron); /settings/catalog 128–262 vs 4–106; /settings/locations 123–267 vs 4–48 (chevron); /sets/en/swsh3 126–264 vs 4–77; /cards/en/swsh3-19 146–244 vs 4–120. /collection/$id edits open as a sheet from card details (fix3 measured the same 146–244 vs 4–120). |
| P3 Export/backup rows | fixed | Rows are ActionRows: leading icon, label and description, trailing icon, 76–149 px tall. Director: the enabled rows (export-json/csv) have cursor pointer and a transparent background. The disabled rows (backup-create, restore-file) have cursor not-allowed, a surface-2/60 background, `aria-disabled=true` and a "Later build" badge. Round 2 initially left these partly broken (styles overridden); fix3 fixed that. |
| P4a /add language filter | fixed | Director: All, EN and JA are one segmented control. All three sit at top 122, each 118×44. The set select is full-width below it. |
| P4b Result thumbnails | fixed | Director: thumbnail x = 16 on both Charizard rows (was 0). |
| P5 Focus ring on sheet title | fixed | Director: focus lands on the H2 "Charizard V" (tabindex -1), outline-style none. Fix3: a Tab-focused button still shows a solid 2 px outline. |
| P6 Startup gate | done (a, b, c); 5–10 s not reproduced | Director: `fdx:` measures after reload were db-open 28, gate-total 43, services 15, migrate-user 6, recover-install 9, catalog-open-en 47 ms. Each DB opens once and in-app navigation never re-gates (child). Also see "Startup finding" below. |
| P7 Pluralization | fixed | Director: set detail shows "200 missing · 1 duplicate". Counters now go through `plural()`. |
| P8 Confirm-sheet art late | fixed | Director: 150 ms after opening, `card-art-low` (low.webp, complete, 245 px) is already showing and high.webp is fading in (opacity 0.24, then 1). Box is 112×156.4, ratio 0.716 (63:88). |
| C4 e2e | fixed | Two projects, mobile 390×844 and desktop 1280×800. New specs: `core-flow.spec.ts` (onboarding → install → add 2 → one ×2 tile → detail → JSON export) and `routes.spec.ts` (18 routes, no console errors, no page errors, scrollWidth ≤ innerWidth). The smoke spec is fixed. Director run: 12/12 passed. |
| C16 Perf test | fixed | `packages/core/test/perf.test.ts` searches a 40,000-card synthetic catalog in 5–26 ms and lists a 5,000-row collection grid in 20–29 ms, against a 300 ms limit. These are node SQLite numbers, not device numbers. |
| Pill wording | fixed | Code: prices_only now starts with "Updating prices" and ends with "Prices updated" (`sync.tsx:95,117`). The child saw "Updating prices · 0 %" then "Prices updated" with the network slowed. I did not trigger a live TCGdex update myself. |
| C7 Tap targets ≥ 44 | fixed | Director: no offenders on /, /collection, /sets, /sets/en/swsh3, /cards/en/swsh3-19, the copy-editor sheet, /settings/data, /settings/catalog, /settings/locations, /add or the confirm sheet. The copy-editor "Save" was 37×44 after round 2; it is now 62×44 (fix3). |
| C13 | fixed | Director: /sets shows "1 / 201 · <1%"; the set ring also shows "<1%". |
| C14 | fixed | Director: "2 of 2 copies valued". The source picks "copy" when there is one copy (card-details.tsx:363); the child saw "1 of 1 copy valued" in the browser. |
| C9 `<nav>` at 1280 | ok | Was already present (owner saw nav=true). The desktop routes spec is green. |
| Lint warnings | partly | 22 → 21 warnings, 0 errors. The 21 left are all `react-refresh/only-export-components`; clearing them means splitting about 12 files, which isn't cheap. |
| C15 `.fdx` backup | known gap | Still disabled in the UI, now with a clear disabled look and a "Later build" badge. |

## Fixes beyond the list (fix3)
- **Root cause behind P3, P4b and C7:**
  - `globals.css` had element resets outside any CSS layer, so they silently beat Tailwind utilities. That reset button padding, colour, background and cursor, and paragraph margins.
  - Fix3 moved the resets into `@layer base`. It diffed the layout before and after on 16 screens (`.agent/scratch/diff-final.txt`) and fixed the regressions it found at the component level: Button/LinkButton caller overrides, the set-tab "Missing 200" ellipsis, and the Sort label ellipsis.
- **What will look different:** button fills and paddings that were written but never applied now show. Primary buttons are filled with the accent colour, the Scan button has a surface fill, back buttons are accent-coloured, and some `mt-1` paragraph spacing is +4 px. This is the authored design, but the owner hasn't seen it yet and should look at it on a phone.
- **React warning:** `fetchpriority` → `fetchPriority`, caught by routes.spec.

## Startup finding (relevant to P6)
- **A background tab never finishes the gate.** jeep-sqlite is a Stencil component that hydrates on `requestAnimationFrame`. A hidden tab therefore sits on "Opening your collection…" indefinitely and resolves within about 1 s of becoming visible. I reproduced this: 40 s stuck as a background CDP tab, then 1 s after `Page.bringToFront`.
- **Possible cause of the owner's 5–10 s:** if he reloaded while the tab was not in front, that alone would explain it.
- **Native:** there is no jeep-sqlite on native, so this does not apply there.
- **Cheap follow-up (not done):** call `customElements.whenDefined('jeep-sqlite')` and skip `componentOnReady` when the page is hidden, or simply accept it, since web is dev mode.

## Test counts (director run, final code)
- `npm run typecheck`: clean.
- `npm run lint`: 0 errors, 21 warnings.
- `npm test`:
  - core vitest 169/169 (163 + 6 perf);
  - mobile vitest 9/9;
  - recognition pytest 1/1.
- catalog-builder: 14/14 (unchanged, not re-run this round).
- `npm run e2e`: 12/12 passed (mobile 9, desktop 3) in 38.7 s.

## Remaining known gaps
- `.fdx` backup/restore is not implemented. It is disabled in the UI, which is honest about it.
- SyncService `refresh` and `incremental` modes are UNSUPPORTED and disabled in the UI. Only `prices_only` exists.
- The web writable-catalog price update was not checked value-by-value. Native writes are untested.
- Perf numbers are node-only. Device timing needs the Mac (use the `[fdx] startup` console line and the `fdx:*` measures).
- Native items are still untested: backup exclusion, SQLCipher compliance, free space.
- `vite build` with dev-packs excluded is unit-tested only.
- 21 react-refresh lint warnings remain.
- The browser profile in my director session reset between rounds (the daemon restarted), so I re-onboarded. Reload persistence inside one browser session was confirmed across about 15 full navigations.
- Owner-batch questions are still open: publisher legal name, contact and privacy URL; iPhone-only vs iPad; SQLCipher export compliance; whether the `#ffcb05` accent is legally comfortable.

## Dev server
- Vite is LISTENING on 0.0.0.0:3200, PID 4212.
- Both children said 3200 was down when they started, so each restarted one instance. PID 4212 is fix3's.
- I left it running. If it isn't up, run `cd C:/Projects/flashydex/apps/mobile && npm run dev`.

## What the owner should try on his phone over LAN
1. Phone on the same Wi-Fi. Open `http://10.0.0.4:3200` (the PC's LAN IPv4). Keep the tab in front while it loads. A tab opened in the background will sit on "Opening your collection…" until you switch to it.
2. First run: Get started → Continue → Continue → Start download. Wait for "English catalog ready".
3. Look at the tab bar on any tab. The raised Scan circle should have a readable "Soon" under it, not covered.
4. Tap Add. All / EN / JA should be one row, with "Any set" full-width below. Search "Charizard". Thumbnails should sit 16 px in from the edge.
5. Tap Charizard V. The art should show at once (low-res, then sharp) and the title should have no yellow box. Tap + to 2, then "Add 2 copies".
6. Collection: one tile reading "×2 · Holo · Charizard V · 19/189 · Darkness Ablaze". Open it and check "2 of 2 copies valued". Tap a copy: the Save button should be accent-coloured and easy to hit.
7. Sets → Darkness Ablaze: the header shows "‹ Sets" with the title not touching it, "<1%", and "200 missing · 1 duplicate".
8. Settings → Import, export & backup: the title shows with a chevron-only back. Share JSON and Share CSV are proper rows. Back up now and Restore read "Later build" and look disabled.
9. Home → Update prices: the pill should read "Updating prices…" then "Prices updated".
10. Check the newly visible button fills and paddings overall (filled primary buttons, Scan fill, accent back buttons). This is the one change the director could not judge without visuals.
11. If startup is slow, open devtools over USB or look for the `[fdx] startup` console line to get the numbers.
