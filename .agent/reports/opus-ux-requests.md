# Requests from Opus (UX / recognition) to other owners

Each item names the doc it touches (owner in brackets). UX.md documents a working fallback for every item, so none blocks Phase 1 implementation.

## To Sol (ARCHITECTURE / API / DATA-MODEL)

- **N1 Navigation conflict (decision needed from director):** ARCHITECTURE says the bottom nav is "Dashboard, Collection, Sets, Settings; prominent Add action links to /add". My task file says 5 slots with a center Scan button, disabled in Phase 1. UX.md follows the task file: center Scan slot `aria-disabled`, never opens a camera, and tapping it opens a "Camera scanning is coming" sheet whose main button goes to `/add`. Add is also a permanent top-bar button on every primary screen. No `/scan` route in Phase 1, so ARCHITECTURE's "no scanner route" rule still holds. Please confirm or overrule in ARCHITECTURE.md.
- **N2 Page routes not in the ARCHITECTURE tree:** `/custom-cards/new` and `/settings/locations` (UX.md §1.1). Please add them.
- **R1 Grouped collection list:** `GET /api/owned-cards?view=groups` (same filters and paging as now). Returns one row per (identity, variant, variantDetail) with `count`, a conditions summary, a grades summary and a representative OwnedDto. The grid needs it to show one tile per card with a ×N badge. Fallback: one tile per copy, badged with `duplicateCount`.
- **R2:** add `localId` filter to `OwnedListQuery` (search the collection by collector number).
- **R3:** owned-cards sorts `value_desc`, `value_asc` (null last) and `count_desc` (needs R1).
- **R4:** catalog card search by set abbreviation (`abbreviation.official`, e.g. `DAA`). Also expose `setCode` in CardSummary/SetSummary. Recognition needs the same field in its manifest.
- **R5:** `owned=true` filter and a `completion_desc` sort on `SetListQuery` (Sets "Collecting" view).
- **R6:** `series` in SetSummary plus an `excludeSeries` filter, so the 15 digital-only TCG Pocket sets (`tcgp`) can be hidden by default.
- **R7:** owned-cards filter `priced=none|some` in the display currency (Dashboard "N cards have no price data" link).
- **R8:** extend `packages/schemas/src/recognition.ts` with optional fields `signals`, `ocrOnly`, `variantHints`, `ocr`, `detection`, `index` (RECOGNITION-DESIGN §6). The existing stub stays valid.
- **R9:** a web workspace script `npm run recognition:manifest` that writes `data/recognition/manifest.jsonl` (format in RECOGNITION-DESIGN §7.1). Phase 2, but owned by web/tooling.
- **R10 (data fact for DATA-MODEL / acceptance):** only 3,882 of 12,781 JA card entries and 21,987 of 23,736 EN entries have an `image` URL (survey of all 404 set-detail responses, 2026-10-30). The "No catalog image" placeholder is a first-class, common state. Acceptance criteria should test it.

## To Terra (tooling / deploy)

- **T1:** the live camera (Phase 3) and Service Worker/PWA install need a secure context. `http://<pc-ip>:3200` is not one. Plan local HTTPS (mkcert + `next dev --experimental-https`, or Caddy with a local CA) before Phase 3. Phase 2's "Identify from photo" uses a file input and works over plain HTTP.
- **T2:** `data/recognition/` must be gitignored. Reference images are copyrighted; expect about 0.5 GB, budget 1.5 GB.
