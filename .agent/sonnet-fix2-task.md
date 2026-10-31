# sonnet-fix2 — FlashyDex Phase 1, Stage C round 2 fixer

Project root: C:/Projects/flashydex (cd there first). Product name FlashyDex / package `flashydex`.
You are a Claude Sonnet fixer working under the Opus director. Builders are finished; you may touch both UI and core areas listed below.

## Context (read first, briefly)
- `.agent/review/parent/REVIEW-NOTES.md` — the owner's visual review (P1–P8 binding).
- `.agent/review/director/STAGE-C-DEFECTS.md` — round-1 defects (C-items).
- `docs/UX.md` for layout/copy; `apps/mobile/src/styles/tokens.css` for design tokens.
- State: everything committed on `main`. typecheck clean; lint 0 errors / 22 warnings; vitest core 163/163, mobile 9/9; catalog-builder 14/14; pytest 1/1. e2e red (smoke spec). C1 snapshot shift is fixed and verified.
- Dev server is ALREADY running on 0.0.0.0:3200 (Vite, `apps/mobile`). Use http://127.0.0.1:3200. Do NOT start another dev server, do NOT kill it, do NOT run `vite build`/`next build`. Playwright's `webServer.reuseExistingServer` will reuse it.

## Your files (you may edit)
- `apps/mobile/src/routes/**`, `apps/mobile/src/components/**`, `apps/mobile/src/lib/**`, `apps/mobile/src/data/**`, `apps/mobile/src/styles/globals.css`
- `apps/mobile/src/platform/**` (only if P6 timing marks need it)
- `apps/mobile/e2e/**`, `apps/mobile/playwright.config.ts`
- `packages/core/src/**` and `packages/core/tests/**` (or wherever core tests live) — for C16 and pill/sync wording if the string originates there
- `apps/mobile/eslint.config.js` only to fix genuine misconfig, never to disable rules wholesale
## Don't
- Do NOT edit `apps/mobile/src/styles/tokens.css` except to ADD a new token if a defect truly needs one (never change existing values).
- NO schema / migration changes (packages/schemas, db migrations, table definitions).
- Do not edit BRIEF.md, SPEC.md, docs/*.
- No `git commit` / `push`.
- NEVER call capture_screenshot or view any image (crashes the session with HTTP 400). Verify with `js()` DOM checks only. Use browser session `session="fix2"` on every browser_exec call.
- Keep everything the owner praised ("Works well" list in REVIEW-NOTES) intact — fix only what is listed.

## Do — P items (owner visual review, verbatim + fix direction)
P1 **Tab bar — raised Scan button clips its label.** At 390 the center button (64px circle, y≈780) sits on top of the "Scan"/"Soon" label (span at y=821). Label unreadable on every screen. Reserve label space below the circle or drop the text label for the center slot and keep aria-label; the "Soon" badge must stay legible.
  Acceptance: at 390×844 the label/badge element's bounding rect is entirely below the circle's rect (label.top >= circle.bottom) and fully inside the viewport (label.bottom <= innerHeight, left>=0, right<=innerWidth). If you drop the text label, the "Soon" badge must still satisfy this (or be placed so it does not overlap any other text) and the button keeps `aria-label`.

P2 **Sub-page header collision.** On /settings/data the back control's text "Settings" runs into the centered title "Import, export & backup". Long titles must truncate (ellipsis, max ~60% width) and the back label should collapse to the chevron when the title is long. Check every sub-route header (/settings/*, /sets/$id, /cards/*, /collection/$id).
  Acceptance: on /settings/data, /settings/catalog, /settings/locations, /sets/en/swsh3, /cards/en/swsh3-19, /collection/<an owned id> at 390, the title rect and back-control rect do not intersect, and the title has `text-overflow: ellipsis` + `overflow:hidden` + `white-space:nowrap`.

P3 **Export/Backup rows have no affordance.** "Share JSON", "Share CSV", "Back up now", "Restore from backup…" render as centered plain text inside the card. Make them proper rows (leading icon, label, trailing chevron/icon, ≥44px, pressed state) or filled/outlined buttons. Disabled rows (backup "later build") must look disabled, not just dim text (e.g. `aria-disabled`, disabled styling, a "Later build" note/badge).

P4 **/add filter row + result thumbnails.** (a) Language chips wrap to two lines (All / EN on line 1, JA on line 2) beside a floating "Any set" select — cramped. Use one segmented control (All|EN|JA) full-width above the set select, or one row with both fitting at 390. (b) Result row thumbnails are drawn at x=0, 40px wide, flush against the screen edge and visually clipped (rows have px-4, img reports x=0). Thumbnail should sit inside the row padding at ~16px.
  Acceptance: language options all share the same `top` (single line); every result-row thumbnail `getBoundingClientRect().x >= 12`.

P5 **Focus ring on sheet title.** Opening the confirm sheet moves focus to the "Charizard V" heading and shows a yellow outline around non-interactive text. Programmatic focus should use `outline: none`/`:focus-visible` on headings (keep visible focus for keyboard users on controls).
  Acceptance: after opening the confirm sheet, the focused heading (tabindex=-1) has computed `outline-style: none` (or outline width 0); buttons still show focus-visible styling.

P6 **Web startup gate 5–10 s per hard reload** ("Opening your collection…"). Not a blocker, but: (a) add `performance.mark`/`performance.measure` around DB open / migrate / restore (names like `fdx:db-open`, `fdx:migrate-user`, `fdx:migrate-catalog`, `fdx:gate-total`) and `console.info` the durations once in dev; (b) if the gate is dominated by IndexedDB restore, confirm the user DB and catalog are not opened/read twice (fix if they are); (c) ensure in-app navigation never re-gates. Report the measured numbers.

P7 **Pluralization**: set detail "200 missing · 1 duplicates" → "1 duplicate". Audit other counters (copies, sets, cards) — use one helper (e.g. `plural(n, 'duplicate')` in `lib/format.ts`) everywhere a count is rendered next to a noun.

P8 **Confirm-sheet art loads late.** First open shows an empty gray card box for ~1 s before high.webp arrives. Show the already-cached low.webp immediately and swap to high.webp when loaded, so the sheet never looks empty. Keep the 63:88 box with no layout shift.

## Do — carry-over items
C4 **e2e**:
  - Fix `apps/mobile/e2e/sqlite.smoke.spec.ts` (fresh profile → app gate resolves to `/welcome`; assert DB opens and that page).
  - `playwright.config.ts`: two projects — `mobile` 390×844 (isMobile, hasTouch, deviceScaleFactor 1 is fine) and `desktop` 1280×800. Keep `reuseExistingServer: true` (dev server already on 3200). Specs that only make sense on one project may `test.skip` on the other, but core-flow and routes must run on both.
  - `core-flow.spec.ts`: onboarding (/welcome → notice → languages → sets → start download) → dev pack install ("English catalog ready") → /add search "Charizard" → Charizard V → qty 2 → Add → /collection shows ONE tile with "Charizard V" and "×2" → open detail shows set "Darkness Ablaze" and "19/189" → /settings/data Share/Export JSON triggers a download whose JSON contains "Charizard V". Use generous timeouts for the pack install. Each Playwright test gets a fresh context (fresh IndexedDB) — that's intended.
  - `routes.spec.ts`: after onboarding + install (do it once in a `beforeAll`/serial setup or per test with a helper), visit every route: `/`, `/collection`, `/add`, `/sets`, `/sets/en/swsh3`, `/cards/en/swsh3-19`, `/settings`, `/settings/catalog`, `/settings/data`, `/settings/locations`, `/settings/about`, `/settings/privacy`, `/settings/licenses`, `/custom-cards/new`, `/welcome` routes as applicable; collect `console` errors + `pageerror` → assert none; assert `document.documentElement.scrollWidth <= window.innerWidth`.
  - `pack-install.spec.ts` must stay green.
  - `npm run e2e` from repo root must pass fully on both projects.
C16 **perf test** in core vitest: build a 40,000-row synthetic catalog in-test (in-memory SQLite via the same driver the core tests already use; batch inserts in a transaction), then run the real catalog search (the same service/repo method the /add screen uses) for a few queries ("char", "pikachu", a number like "19") and assert each completes < 300 ms (warm up once first). Keep total test runtime reasonable (< 20 s). Also add the acceptance-64 equivalent if cheap (collection grid query over e.g. 5k owned rows < 300 ms).
**Pill wording**: while a prices-only update runs, the status pill says "Catalog download started". It must say something like "Updating prices…" (and on completion "Prices updated" / the existing done message). Find where the pill text is derived from the job kind and branch on prices_only vs install.
**C7 / C13 / C14 re-measure in the browser**:
  - C7: on /collection, /sets, /sets/en/swsh3, /cards/en/swsh3-19, the filter sheet, /add confirm sheet — every visible `button, a, [role=tab], [role=button], input, select, [role=switch]` has rect width ≥ 44 and height ≥ 44 (inline text links inside paragraphs exempt). Fix any remaining offenders (min-height/min-width or padding; hit-area via ::before is fine).
  - C13: /sets list with 1/201 owned shows "<1%" (not "0%").
  - C14: card details shows "1 of 1 copy valued" when one copy, "2 of 2 copies valued" with two.
**Lint warnings → 0 where cheap**: fix the 22 warnings that are simple (unused vars, missing deps that are safe, etc.). Don't disable rules globally; don't do risky refactors. Report remaining count.

## Verify (all must pass before reporting)
From repo root: `npm run typecheck && npm run lint && npm test && npm run e2e`.
Browser DOM checks on the running server, `session="fix2"`:
```
new_tab('http://127.0.0.1:3200/')
cdp('Emulation.setDeviceMetricsOverride', width=390, height=844, deviceScaleFactor=1, mobile=True)
```
(If the browser profile has no catalog installed, run onboarding through the UI first.) Measure and record numbers for: P1 (circle rect vs label/badge rect, viewport), P2 (title vs back rects on the 6 sub-routes), P4a (chip tops), P4b (thumbnail x ≥ 12), P5 (outline-style of focused heading), P7 strings, C7 offender list (should be empty), C13, C14, pill wording (click Update prices and read the pill text while it runs), P6 timings from console.

## Report
Write `.agent/reports/sonnet-fix2-report.md` BEFORE you run low on turns (write a draft early and update it): per item (P1–P8, C4, C16, pill, C7, C13, C14, lint) → fixed/partly/not, files changed, and the measured evidence; final command outputs (test counts, lint counts, e2e pass/fail per project). If you run out of budget, the report file must still exist with what's done and what isn't.
