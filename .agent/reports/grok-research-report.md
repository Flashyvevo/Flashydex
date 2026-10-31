# Grok research report (Stage A)

Role: research and documentation. No code outside these files was edited. No commit. No scrape of TCGPlayer, eBay, or PriceCharting.

## Produced

- `.agent/research/tcgdex-api.md`
- `.agent/research/pokeum-notes.md`
- `.agent/research/variants-and-pricing.md`
- `.agent/reports/grok-research-report.md` (this file)

Raw responses are in the Hermes scratch dir `C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/flashydex-research/` (set lists, 404 set details, 44 card details, image probes). Those are scratch, not repo files.

## Verified

Set lists, curl, 2026-10-30T23:38:17Z:

- `GET https://api.tcgdex.net/v2/en/sets` → 200, 35673 bytes, 220 sets. Headers: `ETag`, `Cache-Control: no-cache, no-store, must-revalidate`, `X-Powered-By: Express`. No rate-limit header.
- `GET https://api.tcgdex.net/v2/ja/sets` → 200, 16303 bytes, 184 sets. Same header shape.
- Conditional `GET /v2/en/sets` with that ETag → 304 Not Modified.

Set details: Python urllib, concurrency 6, 404 requests in 17.7 s. 399×200, 5×404. The 404s were JA ids containing `+` (`SM1+`, `sm2+`, `SM3+`, `SM4+`, `SM5+`) requested unencoded. Retried with `%2B`: all 200, all `cards: []`. Interesting response headers across the pull: `etag`, `cache-control` only.

Card details: curl, 44/44 HTTP 200. Ids listed in `variants-and-pricing.md`.

Images, curl:

- `.../en/swsh/swsh3/136/{high,low}.{webp,png,jpg}` all 200. Measured high 600×825, low 245×337, including png. `low.png` was 62661 bytes, not the ~900 KB / 600×825 Pokeum's comment describes.
- Bare card URL and bare univ symbol URL return a 295-byte HTML note telling you to add the extension.
- `univ/swsh/swsh3/symbol.{webp,png,jpg}` and `univ/neo/neo1/symbol.{webp,png}` → 404. `en/swsh/swsh3/symbol.webp` and `en/neo/neo1/symbol.webp` → 200.
- `https://assets.tcgdex.net/ja/SV/SV1S/001/low.webp` → 200 image/webp 19826 bytes. `high.webp` → 200, 92266 bytes.

Other live checks:

- `GET /v2/en/variants` → `["firstEdition","holo","normal","reverse","wPromo"]`.
- `GET /v2/en/cards?variants.wPromo=eq:true&pagination:page=1&pagination:itemsPerPage=3` → `[]`.
- `GET https://api.tcgdex.net/v2/graphql` → 200, ~1.6 MB HTML. No query sent.
- npm `@tcgdex/sdk` latest → 2.9.0, MIT, node >= 18.
- Pokeum releases API → `[]`; `/releases/latest` → 404; ONNX download URL → 404; only public tag `v1.5.2`.
- PyPI `onnxruntime` 1.26.0 → `requires_python >= 3.11`, wheel `onnxruntime-1.26.0-cp312-cp312-win_amd64.whl` exists.
- Docs fetched with curl from tcgdex.dev: rest, assets, faq, reference/card, reference/set, sdks/javascript, markets-prices, filtering, graphql, status.

Catalog counts from the set-detail files: EN 23736 card briefs (1749 missing image, 4 empty sets). JA 12781 card briefs in the 179 first-pass files (8899 missing image, 63 empty) plus 5 empty plus-id shells. Card-id collision: `neo4-100` through `neo4-113` exist in both languages. Set-id collision: `neo1`–`neo4`.

Pokeum read: `tcgdex.py`, `sync.py`, `store.py` (schema and upserts), `models.py`, `constants.py`, `README.md`, `LICENSE`, `pyproject.toml`, `requirements.txt`, `requirements-dev.txt`, `openwiki/quickstart.md`, `openwiki/reference-data.md`, `training/README.md`, frontend `collection.ts` and `exporters.ts`, and function signatures across api/recognize/signals/variants/vision. No 3.13-only syntax found. Their symbol URL helper and skip predicate were checked against the live API and both are wrong for us (details in the notes).

## Incomplete

- Did not download `/v2/{lang}/cards` (the all-briefs list) or measure its size. Not needed; set detail already has the briefs.
- Did not conditional-GET a set detail, only the set list. Set-detail responses carry ETags; whether they 304 is untested.
- Did not stress concurrency above 6, and did not run long enough to see a daily quota. "No published limit" plus one 18-second burst is not a promise.
- Did not install pokeum's requirements on Python 3.12. Only onnxruntime's wheel tag was checked.
- Did not fetch the DINOv2 upstream LICENSE. The Apache claim is pokeum's README.
- GraphQL was not queried. Docs say the page is unfinished.
- `wPromo: true` was not found. The filter returned an empty list; that could mean no such cards, or that the filter doesn't work on nested booleans. I did not page the whole catalog to distinguish those.
- Pricing frequency is a 44-card stratified sample, not a catalog rate. Said so in the variants note.
- JA `SV4a` and `SV3a` are both named レイジングサーフ in the set list (320 vs 92 cards). I did not investigate which is the real one. Flagged here rather than guessed.
- Doc pages were HTML-stripped. A few reference tables may have lost a column in the strip. Field optionality in `tcgdex-api.md` is from the live JSON, not from those tables, except where I explicitly cite the docs.

## Open questions for the architect

1. Catalog primary key must include language. `neo4-100`..`neo4-113` and set ids `neo1`–`neo4` collide across EN and JA. The brief's `catalog_card_id` text is not unique in a bilingual database. Recommend `(language, tcgdex_id)` unique, and the same pair on collection rows.
2. Empty shells (68 JA, 4 EN) advertise a `cardCount.total` and return `cards: []`. Sync progress UI should say "not published" rather than "0 of 101 owned", and must not mark them synced-forever the way Pokeum's skip rule would. The 15 `CS*` rows all named トリプレットビート look like placeholder duplicates of a set that actually lives at `SV1a`. Hide empty shells from the set list, or show them as unavailable?
3. Symbol URLs from the API are on `assets.tcgdex.net/univ/...` and 404 when the extension is appended. Rewriting `univ` → `en` worked for the two symbols I tried. Is that rewrite acceptable, or do we skip symbols until TCGdex fixes the host?
4. Price mapping is in `variants-and-pricing.md`. The dangerous cases: 1st-edition rows that also contain `unlimited-holofoil`; pokeball/masterball rows whose tcgplayer key is `holofoil` on a different product; shadowless with a product id and a null price; cardmarket `avg` vs `avg-holo` not splitting 1st vs unlimited. Please confirm the enum before Sonnet writes the schema. I did not see non-holo `1st-edition` or `unlimited` keys; the docs list them.
5. `variants.wPromo` is in the API's variant list and was never true in sample or in a filtered query. Keep the column, don't build UI for it yet?
6. Incremental sync: set-list ETag 304 works. Card `updated` excludes pricing (docs, and the field is separate from `pricing.*.updated`). A nightly price pass has to re-GET card detail; there is no price-only endpoint. Confirm that is acceptable at ~36k requests, ~15–25 min at concurrency 8–12, extrapolated from a 0.263 s latency I measured at concurrency 6.
7. `@tcgdex/sdk` 2.9.0 is MIT and real. I recommend plain `fetch` for the sync. Disagree if you want their image helper and query builder in the web app for ad-hoc search.
8. Pokeum ONNX weights are not at the URL their README publishes (404, no GitHub releases). Phase 2 cannot assume that file exists. Phase 1 is unaffected.
9. JA USD prices were absent on all 10 JA samples, while several had EUR. Portfolio default currency is USD (brief). JA cards will show EUR-only or blank. Confirm the UI shows "no USD price" rather than hiding the card or zeroing the total.
10. `cardCount.official` is 0 on promo sets (`SV-P`, `M-P`, `mep`). Don't render `001/000`. Display the localId alone when official is 0.
