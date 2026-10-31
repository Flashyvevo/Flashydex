# Opus UX and recognition report (Stage A)

## Files I wrote (all within my ownership)
- `docs/DESIGN-TOKENS.md`: the design system. Covers color (dark default and light), type, spacing, radii, shadows, motion and reduced-motion, rarity/condition/grade/variant/qty/price badges, the 63:88 card frame and its "no image" placeholder, the paste-ready Tailwind v4 `@theme inline` mapping, and the font decision.
- `apps/web/src/styles/tokens.css`: 226 `--ps-*` custom properties. No other declarations.
- `docs/UX.md`: specs for every Phase 1 screen at 390 px and ≥ 1024 px: shell/nav, Dashboard, Collection (grid, list, filter sheet, search), Card Details plus copy editor, Sets and Set detail, Add flow, Storage locations, Custom cards, Settings/Data, and the Scanner (Phase 3, disabled now). Each has states, copy, accessibility notes and Playwright hooks.
- `docs/RECOGNITION-DESIGN.md`: the Phase 2 plan, decision-complete:
  - pipeline and service layout
  - what to adopt from each Pokeum file
  - model ladder
  - fusion extensions
  - API contract
  - manifest and index build with size/time estimates
  - Python 3.12 notes
  - eval gate, task breakdown and risks
- `.agent/reports/opus-ux-requests.md`: requests to Sol (N1–N2, R1–R10) and Terra (T1–T2).
- This report.

## Key decisions
- **Look:** dark near-black UI with Pokémon-yellow `#ffcb05` as the only saturated color. Card corners use `border-radius: 4.8% / 3.4%`, which matches the real 3 mm corner at any size.
- **Font:** Inter via `next/font`, self-hosted at build. That is about 45–50 KB, makes no third-party request, works on LAN and offline, and avoids layout shift through the auto fallback. It also gives the same numbers on phone and PC. Japanese names fall back to system fonts, so no CJK webfont is shipped.
- **Navigation:** 5 slots on mobile with a raised center Scan button. In Phase 1 the Scan button is `aria-disabled`; tapping it opens a sheet that sends you to `/add`. "Add" is a permanent top-bar button. Desktop gets a 240 px sidebar.
- **Fast add path:** `+` → type → tap result → "Add to collection" (3 taps). Defaults are qty 1, NM, raw, and a variant chosen from the catalog by priority.
  - Nothing saves until Add.
  - After adding you get "Add another" (query selected, keyboard open) and an Undo.
  - Location and purchase details can carry over between adds in one session, for logging binder pages.
- **Recognition:** Pokeum's fine-tuned ONNX model is not downloadable (release 404; Grok's research agrees). The default is `onnx-community/dinov2-small`, Apache-2.0, 88.5 MB, using its CLS/pooled output. Pokeum's `reshape(N,-1)` must not be copied as-is. Fine-tuning with Pokeum's `training/` is the fallback if the eval gate fails.

## What I checked (commands and results)
- **WCAG contrast:** a Python script checked 40 color pairs. All text pairs are ≥ 4.5:1 after two fixes:
  - DMG badge: `#ef4444` (3.76) → `#dc2626` (4.83).
  - New `--ps-border-input` for form-control borders, since `border-strong` was 1.94:1 on bg.
  - Disabled text and the decorative `--ps-border`/`--ps-border-strong` dividers stay below 3:1 on purpose.
- **tokens.css:** `grep -nE '^\s*[a-z][a-z-]*\s*:'` returns 0 matches (custom properties only); braces are balanced. `color-scheme` moved to globals.css (in the §9 snippet).
- **TCGdex (live curl, 2026-10-30):**
  - EN 220 sets / 23,964 `cardCount.total`; JA 184 / 18,031.
  - Across all 404 set-detail responses: EN has 23,736 card entries (21,987 with `image`); JA has 12,781 (3,882 with `image`).
  - TCG Pocket (`tcgp`): 15 sets, 2,480 cards.
  - The rarity lists (EN 42, JA 22 values) are mapped completely in DESIGN-TOKENS §8.1.
  - Furret `swsh3-136`: illustrator "tetsuya koizumi", releaseDate 2020-08-14, abbreviation DAA, variants normal + reverse.
  - JA ids differ from EN (`neo1-001` vs `neo1-1`).
- **Models:**
  - GitHub `/repos/TBLgGamin/pokeum/releases` → `[]`; the README model URL → 404.
  - HF `onnx-community/dinov2-small/onnx/model.onnx` → 200, 88,532,934 bytes.
- **PyPI cp312 win_amd64 wheels:** numpy 2.2.6, onnxruntime 1.26.0, Pillow 12.3.0 and opencv 4.12.0.88 (abi3) all have them; rapidocr 3.9.1 and ImageHash 4.3.2 are pure Python. rapidocr requires full `opencv_python`, which conflicts with headless, so the plan pins only `opencv-python`.
- **Python 3.12 compatibility:** a grep of Pokeum `app/` found no 3.13-only syntax or stdlib use.
- **Cross-checks:** I aligned UX.md with Sol's ARCHITECTURE, DATA-MODEL and API.md (they appeared while I worked): routes, enums, filter and sort params, conflict policy (`skip`/`update`), error codes, restore literal `RESTORE`, export filenames. I also folded in Grok's research (symbol URL `univ`→`en` rewrite, measured `low.webp` sizes of ~16–20 KB, no JA logos).
- No dev server started. Port 3200 already had one listener that I did not start or touch.

## Incomplete or not verifiable here
- No UI was built and nothing was checked visually. The specs are text-only by design (no image viewing allowed).
- Not run on this PC; P2-0 must fill them in:
  - DINOv2 ONNX output names (expected `pooler_output`)
  - latency
  - index build time
  - whether RapidOCR downloads models on first use

## Open questions for the director
1. **N1, nav conflict:** ARCHITECTURE says a 4-tab nav plus a prominent Add; my brief says 5 tabs with a disabled center Scan. UX.md follows my brief in a way that keeps ARCHITECTURE's rules (no `/scan` route, never presented as working). Please confirm.
2. **R1, grouped collection list:** the API returns one row per physical copy. Without a grouped endpoint the grid shows duplicate tiles. A fallback is specified, but it looks noticeably worse on the phone.
3. **R5–R7:** owned/complete set filters, a TCG Pocket hide filter, and a "no price" filter. Each has a documented fallback.
4. **T1, HTTPS on LAN:** this decides when the live camera and PWA install become possible. Phase 2's photo upload works without it.
5. **JA expectations:** only ~30% of JA catalog cards have images, and vintage JA cards have no collector numbers. JA recognition will be clearly weaker; the eval reports it separately.
