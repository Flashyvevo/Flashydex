Project root: C:/Projects/pokescan (cd there first). Read `BRIEF.md` fully, then `SPEC.md`. Follow BRIEF's Agent rules exactly.

## Your role: Grok — research & documentation (Stage A). Read-only on code; you write only the files below.

## Your files (ownership)
- `.agent/research/tcgdex-api.md`
- `.agent/research/pokeum-notes.md`
- `.agent/research/variants-and-pricing.md`
- `.agent/reports/grok-research-report.md`

## Do
1. TCGdex API deep-dive (`.agent/research/tcgdex-api.md`). Use `curl` against https://api.tcgdex.net/v2/ and read `.agent/reference/pokeum/app/reference/tcgdex.py` + `sync.py`. Document, with real sample JSON snippets you actually fetched:
   - every endpoint we need for a full EN + JA catalog sync (sets list, set detail with cards, card detail), response shapes, which fields are optional (`image` missing on some cards — confirm with examples), how `localId` differs between EN and JA (JA numbering like `001/080`? SV-P promos?), how JA set ids and names look, which JA sets have no images.
   - image URL construction (`{image}/high.webp`, `/low.webp`, `.png`), logo/symbol URLs, whether JA assets exist.
   - rate limits / politeness (check response headers, docs at https://tcgdex.dev), realistic request counts for a full sync (one request per card? or does set detail carry enough? what does Pokeum do?), recommended concurrency, and a time estimate.
   - the `@tcgdex/sdk` npm package: version, whether it's worth using vs plain fetch (be opinionated).
   - how to detect catalog changes for an incremental resync (any `updated` fields? set cardCount deltas?).
2. Pokeum notes (`.agent/research/pokeum-notes.md`): walk `.agent/reference/pokeum/` (README, openwiki/, app/). For each module group (reference/sync, recognize, signals, variants, vision, api, frontend, training, tests) write: what it does, key functions/signatures, dependencies (check requirements.txt and pyproject; note it targets Python 3.13 while we use 3.12 — flag any blocker), what is directly reusable for us in Phase 1 (sync logic) and Phase 2 (recognition), what we should NOT copy and why. Note its data model (app/models.py, store.py) and compare to our entity list in BRIEF.md. Note its ONNX model release asset and license implications.
3. Variants & pricing (`.agent/research/variants-and-pricing.md`): enumerate every `variants` / `variants_detailed.type` value seen across a sample of ≥ 30 cards spanning WotC-era (base1, neo), ex-era, SM, SWSH, SV, and JA sets, plus promos; list all `tcgplayer` variant keys (normal, holofoil, reverse-holofoil, 1st-edition-*, unlimited-*...) and cardmarket keys you find. Propose a canonical variant enum for our DB that maps TCGdex variants → our enum → which pricing key to read. Flag cards where pricing is absent (show examples) and how frequently (sample estimate).
4. Report to `.agent/reports/grok-research-report.md` (and print it): paths, what you verified, open questions for the architect.

## Don't
- Don't edit anything outside your files. Don't scrape TCGPlayer/eBay/PriceCharting. Don't speculate — if you couldn't fetch it, say so.
