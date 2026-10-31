# Parent (owner session) visual review — Stage C round 1 build, 2026-10-30

Reviewed in a real Chromium at 390×844 (dSF 2) and 1280×800 against the dev server (web/sql.js build, swsh3 dev pack). Flow walked: /welcome → notice → languages → sets → download → dashboard → /add "Charizard" → confirm sheet → Add 2 → /collection → card detail → /sets → set detail → /settings/data; desktop /collection.

## Works well (keep)
Onboarding copy + disclaimer, dashboard empty states, pack download → "English catalog ready", search results, confirm sheet defaults (Holo preselected, condition "Not set", qty stepper), grouped tile ×2 with Holo chip, card detail (price table, "2 of 2 copies valued", copies list), set detail (ring, Owned/Missing tabs, missing cards dimmed grayscale with dashed outline), desktop sidebar + filter rail. No horizontal overflow at 390 or 1280.

## Defects (fix in round 2)
P1 **Tab bar — raised Scan button clips its label.** At 390 the center button (64px circle, y≈780) sits on top of the "Scan"/"Soon" label (span at y=821). Label unreadable on every screen. Reserve label space below the circle or drop the text label for the center slot and keep aria-label; the "Soon" badge must stay legible.
P2 **Sub-page header collision.** On /settings/data the back control's text "Settings" runs into the centered title "Import, export & backup". Long titles must truncate (ellipsis, max ~60% width) and the back label should collapse to the chevron when the title is long. Check every sub-route header (/settings/*, /sets/$id, /cards/*, /collection/$id).
P3 **Export/Backup rows have no affordance.** "Share JSON", "Share CSV", "Back up now", "Restore from backup…" render as centered plain text inside the card. Make them proper rows (leading icon, label, trailing chevron/icon, ≥44px, pressed state) or filled/outlined buttons. Disabled rows (backup "later build") must look disabled, not just dim text.
P4 **/add filter row + result thumbnails.** (a) Language chips wrap to two lines (All / EN on line 1, JA on line 2) beside a floating "Any set" select — cramped. Use one segmented control (All|EN|JA) full-width above the set select, or one row with both fitting at 390. (b) Result row thumbnails are drawn at x=0, 40px wide, flush against the screen edge and visually clipped (rows have px-4, img reports x=0). Thumbnail should sit inside the row padding at ~16px.
P5 **Focus ring on sheet title.** Opening the confirm sheet moves focus to the "Charizard V" heading and shows a yellow outline around non-interactive text. Programmatic focus should use `outline: none`/`:focus-visible` on headings (keep visible focus for keyboard users on controls).
P6 **Web startup gate 5–10 s per hard reload** ("Opening your collection…") with only the 1.8 MB swsh3 catalog. Web is dev/limited mode, so not a Phase 1 blocker, but: (a) add a timing log (`performance.mark`) around DB open/migrate/restore so native can be measured on the Mac; (b) if the gate is dominated by IndexedDB restore, confirm the user DB and catalog are not re-read twice; (c) ensure in-app navigation never re-gates (it didn't in my run — keep it that way).
P7 **Pluralization**: set detail "200 missing · 1 duplicates" → "1 duplicate". Audit other counters (copies, sets, cards).
P8 **Confirm-sheet art loads late.** First open showed an empty gray card box for ~1 s before high.webp arrived. Show the already-cached low.webp immediately and swap to high.webp when loaded (same as Pokeum's approach), so the sheet never looks empty.

## Carry-over from Stage C round 1 (director's list, still open per fixer report)
C4 e2e: `sqlite.smoke.spec.ts` failing (root now redirects to /welcome); write `core-flow.spec.ts` (onboarding → install dev pack → add 2 → tile ×2 → detail → export JSON) and `routes.spec.ts`; two-project Playwright config (390×844, 1280×800). C15 `.fdx` remains honestly disabled — acceptable for this round; keep UI honest. C16 perf tests: search < 300 ms on a 40k-row synthetic catalog in core vitest. Pill wording during prices-only update says "Catalog download started". C9 verify `<nav>` landmark at 1280 (present in my run: nav=true). C7/C13/C14 need browser re-measure.

## Owner-batch questions (not for the fixer)
Publisher legal name/contact/privacy URL; iPhone-only vs iPad; SQLCipher export-compliance answer; `#ffcb05` accent legal comfort.
