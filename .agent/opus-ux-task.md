Project root: C:/Projects/flashydex (cd there first). Read `BRIEF.md` fully, then `SPEC.md`. Follow BRIEF's Agent rules exactly.

## Your role: Claude Opus — UX/design lead + recognition architect (Stage A). Two deliverables: the Phase 1 UI/UX spec that a Sonnet implementer will build pixel-faithfully, and the Phase 2 recognition design (document only, no code).

## Your files (ownership)
- `docs/UX.md`
- `docs/DESIGN-TOKENS.md`
- `apps/web/src/styles/tokens.css` (create the folders; this is the ONE code file you own — CSS custom properties only)
- `docs/RECOGNITION-DESIGN.md`
- `.agent/reports/opus-ux-report.md`

## Inputs
- `BRIEF.md` (quality bar: owner judges on his phone; dark default; bottom nav; 63:88 card art; no fabricated content), `SPEC.md` PRODUCT SCREENS + RELIABILITY RULES.
- Phase 2 reference: `.agent/reference/pokeum/` — read `README.md`, `openwiki/*.md`, `app/recognize/pipeline.py`, `fusion.py`, `app/signals/*.py`, `app/variants/*.py`, `app/vision/*.py`, `app/api/schemas.py`. Also `.agent/research/pokeum-notes.md` if it exists.
- If `docs/DATA-MODEL.md` / `docs/API.md` exist when you start, align field names with them; if not, use SPEC vocabulary and note it.

## Do
1. `docs/DESIGN-TOKENS.md` + `apps/web/src/styles/tokens.css`: color system (dark default + light), type scale (mobile: body 16px, H1 ≤ 2rem), spacing, radii, shadows, motion durations/easings (respect prefers-reduced-motion but keep micro-interactions alive), rarity accent colors, condition badge colors, grade badge style. Tailwind v4 consumes these via `@theme` — show the mapping. Fonts: system stack or one free Google font — pick and justify (performance on phone).
2. `docs/UX.md`: for each Phase 1 screen — Dashboard, Collection (grid + compact list, filter sheet, search), Card Details, Sets (list + set detail with owned/missing/duplicates), Settings/Data (sync with progress, import with dry-run preview, export, backup/restore), Manual add flow (search → pick card → confirm variant/condition/qty/price → add → "add another"), Storage locations, Custom card creation. For each: layout at 390px and ≥ 1024px (ASCII wireframe is fine), component list, states (loading skeleton, empty, error, offline), interactions, copy for buttons/empty states (real, no lorem), accessibility (labels, focus, 44px targets). Design the Scanner screen too (Phase 3) so the nav has its slot now — mark it "coming in Phase 3" with a disabled state in Phase 1.
   - The add flow must be finishable fast: defaults (qty 1, variant from catalog if only one, condition NM, raw) so a tap-tap-add path exists; everything editable before commit; never auto-saves.
   - Navigation: bottom tab bar on mobile (Dashboard, Collection, Scan [center, prominent], Sets, Settings); sidebar on desktop. Define routes.
   - Card tile: art at 63:88, quantity badge, variant chip, condition/grade badge, price (hide when null — never show $0.00 as a stand-in).
3. `docs/RECOGNITION-DESIGN.md` (Phase 2 plan, no code): pipeline stages per SPEC reference architecture, what to adapt from Pokeum (file by file: detect/rectify, hashes, embedding via ONNX DINOv2-s fine-tuned model from their release, OCR of collector number, set-symbol matching, fusion weights, variant assessment), what to change (our DB/schema; our API contract between Next and FastAPI: request = image bytes + lang hint, response = ranked candidates with per-signal scores + confidence + variant hints, max 3 candidates below threshold), index build strategy for EN+JA (~40k images, disk and time estimate, where the index lives), Python 3.12 compatibility concerns, CPU-only latency target on a typical PC, test strategy (held-out photo set, metrics), risks. Keep it decision-complete so Sonnet can implement Phase 2 from it later.
4. Report to `.agent/reports/opus-ux-report.md` and print it.

## Don't
- No screenshots / image viewing (crashes the session). No code beyond tokens.css. Don't edit docs owned by others (ARCHITECTURE, DATA-MODEL, API). Don't invent prices/cards in examples — use real cards (e.g. swsh3-136 Furret, Darkness Ablaze).
