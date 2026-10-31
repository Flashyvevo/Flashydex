# sonnet-fix3 — FlashyDex Phase 1, Stage C round 2b (remaining items only)

Project root: C:/Projects/flashydex (cd there first). You are a Claude Sonnet fixer under the Opus director. Read `.agent/reports/sonnet-fix2-report.md` (previous fixer) for context. Everything else from round 2 is verified green by the director (typecheck, lint 0 errors, vitest core 169 / mobile 9, e2e 12/12) — keep it that way.

## The remaining defect (one root cause, three symptoms)
`apps/mobile/src/styles/globals.css` lines ~145–161 contain UNLAYERED element rules that beat Tailwind v4's layered utilities:
```
button, a, [role="button"], nav, .no-select { user-select:none; touch-action:manipulation }
:focus-visible { outline … }
[tabindex="-1"]:focus, … { outline:none }
body { … }  h1, h2, h3, p { margin: 0; }
input, select, textarea, button { font: inherit; color: inherit; }
button { background: none; border: 0; padding: 0; cursor: pointer; }
```
Measured by the director at 390×844 (DOM, no screenshots):
1. P3 still partly open: on /settings/data the disabled rows `backup-create` / `restore-file` have class `cursor-not-allowed bg-surface-2/60` but computed `cursor: pointer` and `background-color: rgba(0,0,0,0)` — identical to the enabled rows. Disabled rows must look disabled.
2. C7 offender: copy-editor sheet (card details → tap a copy row) header "Save" button has class `px-3 text-accent-fg` but computed padding-left 0 → 37×44 (< 44 wide); its `text-accent-fg` color is also overridden by `color: inherit`.
3. Systemic: any `<button class="px-*|p-*|bg-*|text-*|cursor-*">` and any `h1/h2/h3/p` with `m*-` utilities silently lose those utilities. fix2 worked around it locally with `px-4!` in CardRow/NavRow/ActionRow.

## Do
1. Move the element-level resets/base rules above (body, h1–p margin, input/select/textarea/button font+color, button reset, img, `:focus-visible`, the `[tabindex="-1"]` rule — keep the latter AFTER `:focus-visible` inside the layer) into `@layer base { … }` so utilities win. Keep `.sr-only`, `.tabular`, `.selectable`, `.scroll-hide` and other component classes as they are (or put them in `@layer components`/`utilities` — your call, behaviour must not change). Do not edit tokens.css.
2. Before AND after the change, run a Playwright probe script (390×844, fresh profile, onboarding + dev-pack install + add Charizard V ×2 — reuse `apps/mobile/e2e/helpers.ts`) over `/`, `/collection`, `/add` (with "Charizard" results + confirm sheet open), `/sets`, `/sets/en/swsh3`, `/cards/en/swsh3-19` (+ copy-editor sheet open), `/settings`, `/settings/data`, `/settings/catalog`, `/settings/locations`, the filter sheet on /collection, and the bottom tab bar. Record for every visible button/a/input/select/h1–h3/p: rect (x,y,w,h), padding, color, background. Diff before/after and list every element whose rect moved/resized > 2 px or whose color/background changed. For each diff decide: intended (the utility the author wrote now applies) or regression (fix it). The owner praised these screens — no unintended visual changes; unexpected spacing growth that breaks a layout must be corrected at the component, not by reverting the layer fix. Put the probe script in `.agent/scratch/` (not in e2e) and delete nothing else.
3. Verify the three symptoms: disabled rows computed `cursor: not-allowed` and a non-transparent background different from enabled rows (or opacity/aria-disabled styling clearly distinct); copy-editor "Save" ≥ 44×44 with accent color; C7 offender list empty on all screens above (same probe as fix2: visible `button,a,[role=tab],[role=button],input,select,[role=switch]` with width or height < 44, inline links in `<p>` exempt).
4. Re-confirm previous round-2 measurements still hold: P1 (Scan "Soon" label top ≥ circle bottom, inside viewport), P2 (bar-title vs back-button rects don't intersect on /settings/data, /settings/catalog, /settings/locations, /sets/en/swsh3, /cards/en/swsh3-19, /collection/<owned id>), P4 (lang chips same top; result thumbnails x ≥ 12), P5 (focused sheet heading outline-style none; a Tab-focused button still shows an outline), scrollWidth ≤ innerWidth everywhere at 390 and 1280.
5. The `px-4!`/`py-2!` important overrides fix2 added may now be redundant — remove them only if the measured rect is unchanged.

## Don't
- NEVER call capture_screenshot or view any image (crashes the session). DOM/Playwright measurements only. If you use browser_exec, use `session="fix3"` and call `cdp('Page.bringToFront')` after every navigation (a background tab never hydrates jeep-sqlite → stuck "Opening your collection…"). Playwright is preferred.
- Dev server is already running on 0.0.0.0:3200 — do NOT start another, do NOT kill it, no `vite build`.
- No tokens.css value changes, no schema/migration changes, no docs/BRIEF/SPEC edits, no git commit/push.

## Verify (must pass)
`npm run typecheck && npm run lint && npm test && npm run e2e` from repo root (lint: 0 errors; warnings must not increase above 21).

## Report
Write `.agent/reports/sonnet-fix3-report.md` (draft early, update at the end): the change, the before/after diff list with your intended/regression verdict per element, measurements for items 3–4, final command outputs (test counts, lint counts, e2e per project).
