# TCGdex API notes (Stage A)

Fetched 2026-10-30 against `https://api.tcgdex.net/v2/` and docs at `https://tcgdex.dev`. Samples below are from those responses, not from the docs' examples. Docs disagree with the live API in a few places; those are called out.

Method: `curl` for set lists, 44 card details, image probes, ETag, and `/variants`. A one-shot Python urllib pull (concurrency 6) fetched set detail for all 220 EN sets and 184 JA sets. Five JA ids containing `+` 404 unless percent-encoded; retried as `%2B` and they are empty shells.

## Endpoints a full EN+JA catalog sync needs

Language segment is `en` or `ja`. No API key. HTTPS only. GET only on the REST API (docs: https://tcgdex.dev/rest). JSON.

Required:

1. `GET /v2/{lang}/sets` — set briefs. One call per language.
2. `GET /v2/{lang}/sets/{setId}` — set detail, including the card brief array. One call per set. Encode `+` as `%2B` (`SM1+` → `SM1%2B`). Unencoded `+` is a 404 even though the id is in the list.
3. `GET /v2/{lang}/cards/{cardId}` — full card. Set detail does **not** carry rarity, variants, pricing, attacks, or `updated`. Those require this call. One call per card you want fully synced.

Not required for the sync, but real:

- `GET /v2/{lang}/cards` — every card brief in that language, unpaginated unless you pass `pagination:page`. Briefs only (id, localId, name, image?). Does not replace (3).
- `GET /v2/{lang}/sets/{setId}/{localId}` — documented alternate for one card (https://tcgdex.dev/rest/set-card). Not needed if you already have `card.id` from the set detail.
- `GET /v2/{lang}/series` and `GET /v2/{lang}/series/{id}` — serie metadata. Set detail already embeds `serie`.
- `GET /v2/{lang}/variants` — live response is exactly `["firstEdition","holo","normal","reverse","wPromo"]`.
- `GET https://api.tcgdex.net/v2/graphql` — 200, ~1.6 MB HTML editor. Docs page (https://tcgdex.dev/graphql) says "Full documentation in progress." No query was run. Do not plan the sync around GraphQL.

Filtering/sorting/pagination (https://tcgdex.dev/rest/filtering-sorting-pagination) applies to list endpoints and still returns briefs. `pagination:page` is off unless you set it; default page size is 100 only when paging is on. Sort default is `releaseDate > localId > id`.

## Set list shape

`GET /v2/en/sets` returned 220 objects. `GET /v2/ja/sets` returned 184. Matches the brief. Keys on every row: `id`, `name`, `cardCount`. `cardCount` is always `{official, total}` on the list (not the richer set-detail count). `logo` and `symbol` are omitted when absent, not null.

EN list: logo present on 157/220, symbol on 169/220.
JA list: logo present on 0/184, symbol on 4/184 (`neo1`, `neo2`, `neo3`, `neo4` only).

Response headers on the EN list (2026-10-30T23:38:17Z), no rate-limit headers:

```
HTTP/1.1 200 OK
Cache-Control: no-cache, no-store, must-revalidate
Content-Type: application/json; charset=utf-8
Etag: W/"8b59-FmedVib2yUiaVn+PINM5rcPvoko"
X-Powered-By: Express
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET,POST,OPTIONS
```

Real list rows (trimmed from the saved JSON):

```
{"id":"base1","name":"Base Set","logo":"https://assets.tcgdex.net/en/base/base1/logo","cardCount":{"total":102,"official":102}}
{"id":"swsh3","name":"Darkness Ablaze","logo":"https://assets.tcgdex.net/en/swsh/swsh3/logo","symbol":"https://assets.tcgdex.net/univ/swsh/swsh3/symbol","cardCount":{"total":201,"official":189}}
{"id":"PMCG1","name":"拡張パック","cardCount":{"total":102,"official":102}}
{"id":"SV-P","name":"スカーレット&バイオレット プロモカード","cardCount":{"total":288,"official":0}}
{"id":"neo1","name":"金、銀、新世界へ...","symbol":"https://assets.tcgdex.net/univ/neo/neo1/symbol","cardCount":{"total":96,"official":96}}
```

There is no `updated` field on a set brief.

## Set detail shape

Top-level keys seen across all fetched set details:

Always: `id`, `name`, `cardCount`, `cards`, `legal`, `releaseDate`, `serie`.
EN optional: `logo` (157), `symbol` (169), `abbreviation` (190, object `{"official":"BS"}` or similar), `tcgOnline` (118, string such as `"BS"`), `boosters` (14, Pokémon TCG Pocket only).
JA optional: `symbol` on exactly 4 sets. No JA set detail has `logo`, `abbreviation`, `tcgOnline`, or `boosters`.

`cardCount` on detail is richer than the list: `official`, `total`, `firstEd`, `holo`, `normal`, `reverse`. `legal` is `{standard, expanded}` booleans. `serie` is `{id, name}`. `releaseDate` is `YYYY-MM-DD`.

`cards[]` briefs have only `id`, `localId`, `name`, and `image` when an image exists. No rarity, no variants, no pricing. Confirmed on every non-empty set fetched.

Real EN detail (base1, cards array omitted):

```
{
  "id": "base1",
  "name": "Base Set",
  "releaseDate": "1999-01-09",
  "abbreviation": {"official": "BS"},
  "tcgOnline": "BS",
  "logo": "https://assets.tcgdex.net/en/base/base1/logo",
  "serie": {"id": "base", "name": "Base"},
  "legal": {"expanded": false, "standard": false},
  "cardCount": {"firstEd": 103, "holo": 64, "normal": 351, "official": 102, "reverse": 0, "total": 102}
}
```

Note `cardCount.firstEd` (103) can exceed `total` (102). `cardCount.normal` (351) is a variant tally, not a card count. Do not use those fields as the number of rows to expect.

Real card brief:

```
{"id":"swsh3-136","localId":"136","name":"Furret","image":"https://assets.tcgdex.net/en/swsh/swsh3/136"}
```

Brief with no image (mep, all 89 cards):

```
{"id":"mep-001","localId":"001","name":"..."}
```

Empty shell (advertised count, zero cards). Live `GET /v2/ja/sets/ADV1`:

```
{"id":"ADV1","name":"拡張パック","releaseDate":"2003-01-31","serie":{"id":"ADV","name":"ADV"},"legal":{"expanded":false,"standard":false},"cardCount":{"firstEd":0,"holo":0,"normal":0,"official":55,"reverse":0,"total":55},"cards":[]}
```

Same shape: EN `jumbo` (160/160, 0 cards), `wp` (7/7, 0 cards), `rc`, `sp`. JA `S1W` (ソード, 60/60, 0 cards), all 15 `CS*` sets (every one named トリプレットビート, 101/101, 0 cards). The set that actually has Triplet Beat cards is `SV1a` (103 cards, fully imaged).

`cardCount.total` != `len(cards)` on three non-empty sets: EN `mfb` 48 vs 34, EN `tk-sm-l` 30 vs 18, JA `web1` 48 vs 47. Trust the array, not the advertised total.

## Card detail shape

`GET /v2/en/cards/swsh3-136` (attacks/description trimmed):

```
{
  "category": "Pokemon",
  "id": "swsh3-136",
  "illustrator": "tetsuya koizumi",
  "image": "https://assets.tcgdex.net/en/swsh/swsh3/136",
  "localId": "136",
  "name": "Furret",
  "rarity": "Uncommon",
  "set": {
    "id": "swsh3",
    "name": "Darkness Ablaze",
    "cardCount": {"official": 189, "total": 201},
    "logo": "https://assets.tcgdex.net/en/swsh/swsh3/logo",
    "symbol": "https://assets.tcgdex.net/univ/swsh/swsh3/symbol"
  },
  "variants": {"firstEdition": false, "holo": false, "normal": true, "reverse": true, "wPromo": false},
  "variants_detailed": [ "...see variants-and-pricing.md..." ],
  "dexId": [162],
  "hp": 110,
  "types": ["Colorless"],
  "evolveFrom": "Sentret",
  "stage": "Stage1",
  "retreat": 1,
  "regulationMark": "D",
  "legal": {"standard": false, "expanded": true},
  "updated": "2026-07-01T21:27:44+01:00",
  "pricing": { "cardmarket": {"unit": "EUR", "updated": "2026-10-30T22:54:33.147Z"}, "tcgplayer": {"unit": "USD", "updated": "2026-10-14T22:55:05.165Z"} }
}
```

Always present on all 44 fetched cards: `id`, `localId`, `name`, `category`, `rarity` (key present; value was JSON null on `P-A-001` and `S12a-001`), `set`, `variants`, `variants_detailed`, `legal`, `updated`, `pricing` (key present; providers may be null).

Omitted or null, with examples:

- `image` omitted: `cel25-25`, `ecard2-H01`, `ecard2-50a`, `mep-001`, `ja/PMCG1-001`, `ja/SV-P-001`, `ja/neo1-001`, `ja/SM1S-001`, `ja/M-P-001`, `ja/web1-001`. Catalog-wide, from set briefs: EN 1749/23736 cards lack `image`; JA 8899/12781.
- `illustrator` omitted on 4/44.
- Pokémon-only: `hp`, `types`, `stage`, `attacks`, `dexId`, `evolveFrom`, `abilities`, `weaknesses`, `resistances`, `retreat`. Trainer-only: `effect`, `trainerType` (sample: `sm1-149`). Energy-only: `effect`, `energyType` (sample: `swsh3-201`, `sv01-258`).
- `regulationMark` on modern cards only (16/44).
- `boosters` on Pocket cards (`A1-001`).
- `pricing.tcgplayer` / `pricing.cardmarket` are null, not omitted, when that market has nothing. Example `A1-001`: `"pricing":{"cardmarket":null,"tcgplayer":null}` and `variants_detailed` is `[{"type":"normal","size":"standard","variantId":"generated"}]` with no `thirdParty` and no `pricing`.

`updated` is on the card and, per the card reference (https://tcgdex.dev/reference/card), excludes pricing. Live values are ISO-8601 strings in three shapes: `2026-03-06T14:10:14Z`, `2026-08-20T08:25:49+01:00`, `2026-09-16T22:51:11.575Z`. Store the string. Do not assume one offset or that fractional seconds are absent.

`localId` was a string on all 44 cards. The reference says "String or Number". Treat it as a string. Never coerce `"001"` to `1` or `"H01"` to a number.

Doc drift worth knowing:

- FAQ (https://tcgdex.dev/faq) still says `variants_detailed` is in development. It is live on every card fetched.
- Card reference says `pricing.tcgplayer.updated` and `.unit` are Numbers. Live values are an ISO string and `"USD"` / `"EUR"`.
- Card reference's example tcgplayer variant key is `reverse`. Live key is `reverse-holofoil`. See the variants note.
- Markets page (https://tcgdex.dev/markets-prices) example imports `@tcgdx/sdk` (missing the `e`) and calls `sdk.cards.get`. The JS SDK page calls `tcgdex.card.get`. Don't treat the marketing page as the client API.

## localId: EN vs JA

`localId` is the collector number alone. It never contains the slash total. Zero of 23736 EN briefs and zero of 12781 JA briefs contain `/`. The printed "001/080" is `localId` + `cardCount.official`, and those two numbers use different padding, so do not zero-pad one to match the other.

EN shapes (all briefs):

- unpadded digits: `"1"`, `"52"`, `"136"` (WotC, ex, DP, HGSS, BW, XY, SM, most SWSH). 8972 len-2, 7241 len-3, 1336 len-1.
- zero-padded 3 digits: `"001"` (SV, some promos, Pocket). 4579 cards.
- promo prefixes: `SWSH001` (307), `SM` (248), `SV` (216), `XY` (211), `TG` (120, trainer gallery), `BW` (101), `GG` (70), `DP` (56), `HGSS` (25), `CC` (25).
- e-Card secrets and splits: `H01`…`H32`, `50a`/`50b` (Aquapolis/Skyridge). `ecard2-H01` and `ecard2-50a` have no image.
- Unown collection `exu`: localIds `A`–`Z`, `!`, and `%3F` (the id is the literal characters percent, 3, F — the encoded form of `?`, not a decoded question mark). Set has cards but zero images.
- One-offs: `Museum` (`mep-Museum`), `ONE`/`TWO`/`THREE`/`FOUR` (Alph Lithograph, `hgss1-ONE` etc.).

JA shapes:

- zero-padded 3 digits on 9808/12781 cards: `"001"`. This is the normal JA form, including promos (`SV-P` localId `001`, card id `SV-P-001`) and old sets (`PMCG1-001`).
- unpadded 3-digit on 2965 cards (later numbers inside large sets, e.g. `S12a` localId `262`, `SV2a` localId `210`).
- eight energy cards in `MC` (スタートデッキ100 バトルコレクション) use letter localIds: `DAR`, `FIG`, `FIR`, `GRA`, `LIG`, `MET`, `PSY`, `WAT`. Card ids `MC-DAR` etc. Names like 基本悪エネルギー. No images on that set.
- Not `001/080`. JA `cardCount.official` is often 0 on promo sets (`SV-P` official 0, total 288; `M-P` official 0, total 132), so there is no honest slash total to print. Display the localId alone when official is 0.

SV-P numbering is not dense: the set has 288 cards and the sampled last brief localId was `290` (from the earlier single-set inspect). Gaps are normal for promos. EN `svp` similarly: 226 cards, sampled last localId `500`.

## JA set ids and names

Ids are short codes, not slugs of the English name. Names are Japanese. Serie names are Japanese.

Examples actually fetched:

- `PMCG1` 拡張パック (1996-10-20), serie `PMCG` / ポケットモンスターカードゲーム. 102 cards, no images, no logo, no symbol.
- `neo1` 金、銀、新世界へ... — same set **id** as English Neo Genesis, different set. See collisions below.
- `ADV1`–`ADV5` — ids exist, `cards: []`.
- `PCG1`–`PCG9` — cards present, no images. `PCG10` empty.
- `XY1a` コレクションX — empty. The whole XY block in the list is empty shells except `CP1` and `CP2`, which have cards and no images.
- `SM1S` コレクションサン — 73 cards, no images. `SM1+` (must be requested as `SM1%2B`) is an empty shell named サン＆ムーン. Same for `sm2+`, `SM3+`, `SM4+`, `SM5+`.
- `S1W` ソード — empty. Many early Sword & Shield JA sets are empty shells (`S1H`, `S1a`, `S2`, `S3`, `S4`, `S4a`, …). Later ones have cards but no images (`S8`, `S8b`, `S6H`, `S6K`). Fully imaged SWSH-era JA sets are the minority: `S9`, `S9a`, `S10a`, `S10P`, `S11`, `S11a`, `S12`.
- `SV1S` スカーレットex — 108 cards, all imaged. Image base `https://assets.tcgdex.net/ja/SV/SV1S/001`.
- `SV-P` スカーレット&バイオレット プロモカード — 288 cards, zero images, official count 0.
- `SV2a` ポケモンカード151 — 210 cards, all imaged.
- `M-P` メガ プロモカード — 132 cards, zero images. `M1L` メガブレイブ — 92 cards, zero images. The whole `M*` block has cards and no images.
- `CS1a`, `CS2b`, and 13 siblings — all named トリプレットビート, all `cards: []`, all dated 2024-04-26, all serie `S` / 剣と盾. Duplicate placeholder rows. Do not show them as real sets with 101 cards.

## Which JA sets have no images

From set-detail briefs (179 files + 5 plus-id retries):

- 0/179 JA set details have a logo. The 5 plus-id shells also have no logo.
- Symbol only on `neo1`–`neo4`, and that URL is the shared `univ` path (see images). No JA-specific symbol was found.
- 30 sets are fully imaged. All of them are late Sword & Shield or Scarlet & Violet: `S9`, `S9a`, `S10a`, `S10P`, `S11`, `S11a`, `S12`, `SV1a`, `SV1S`, `SV1V`, `SV2a`, `SV2D`, `SV2P`, `SV3`, `SV3a`, `SV4a`, `SV4K`, `SV4M`, `SV5a`, `SV5K`, `SV6`, `SV6a`, `SV7`, `SV7a`, `SV8a`, `SV9`, `SV9a`, `SVK`, `SVLN`, `SVLS`.
- 3 partial: `S12a` 4/258 missing, `SV10` 34/132, `SV8` 32/138.
- 83 sets have cards and zero images. That includes every PMCG, neo, VS, web, E-card, PCG, CP1/CP2, the entire SM block, most of S, all of M / M-P / MC, and `SV-P` / `SV11B` / `SV11W` / `SV5M`.
- 68 sets are empty shells (`cards: []`) including ADV, most XY, the CS* duplicates, early S, L/LL, and the five `+` sets. They have no images because they have no cards. The list still advertises a `cardCount.total`.

JA card image that does exist, fetched: `https://assets.tcgdex.net/ja/SV/SV1S/001/low.webp` → 200 `image/webp` 19826 bytes; `.../high.webp` → 200 `image/webp` 92266 bytes. When `image` is absent there is no base URL to suffix. Don't invent one.

## Image URL construction

Card `image` and set `logo` are extension-less bases. The asset host returns this HTML (295 bytes) if you request the base with no suffix — confirmed for `https://assets.tcgdex.net/en/swsh/swsh3/136` and for `https://assets.tcgdex.net/univ/swsh/swsh3/symbol`:

```
To access the final image file, you need to add the extension and/or the quality, see the Assets documentation...
```

Cards: `{image}/{quality}.{extension}`

- quality: `high` or `low`
- extension: `webp`, `png`, or `jpg`

Measured on `https://assets.tcgdex.net/en/swsh/swsh3/136` (2026-10-30):

- `high.webp` 200 image/webp 67756 bytes, 600×825
- `low.webp` 200 image/webp 15778 bytes, 245×337
- `high.png` 200 image/png 327364 bytes, 600×825
- `low.png` 200 image/png 62661 bytes, 245×337
- `high.jpg` 200 image/jpeg 79129 bytes, 600×825
- `low.jpg` 200 image/jpeg 18065 bytes, 245×337

Docs (https://tcgdex.dev/assets) match these dimensions. Pokeum's comment that `low.png` is still 600×825 and ~900 KB is stale. As of this fetch, quality selects the pixel size for png and jpg as well as webp. Prefer `low.webp` for grids and `high.webp` for the card detail view. JPG has a black background (docs); don't use it for UI.

Logos: `{logo}.{extension}` works. `https://assets.tcgdex.net/en/swsh/swsh3/logo.webp` → 200 image/webp 10436 bytes, 360×98. `https://assets.tcgdex.net/en/base/base1/logo.webp` → 200 image/webp 102580 bytes. No quality segment.

Symbols: the API returns `https://assets.tcgdex.net/univ/{serie}/{setId}/symbol`. Appending `.webp`, `.png`, or `.jpg` to that univ URL 404s (swsh3 and neo1 both tested). Rewriting `univ` to `en` and appending `.webp` works:

- `https://assets.tcgdex.net/en/swsh/swsh3/symbol.webp` → 200 image/webp 860 bytes
- `https://assets.tcgdex.net/en/swsh/swsh3/symbol.png` → 200 image/png 4913 bytes
- `https://assets.tcgdex.net/en/neo/neo1/symbol.webp` → 200 image/webp 2460 bytes
- `https://assets.tcgdex.net/univ/neo/neo1/symbol.webp` → 404

Pokeum's `symbol_image_url` appends `.png` to the API base and will 404 on every current univ symbol URL. For Phase 1, either rewrite `univ` → `en` before appending the extension, or skip symbols when that rewrite 404s. JA sets other than neo1–4 have no symbol field at all. No JA logo URL exists in the API to construct.

## Id collisions across languages

Set ids `neo1`, `neo2`, `neo3`, `neo4` exist in both languages and are different sets (EN "Neo Genesis" vs JA "金、銀、新世界へ..." for neo1).

14 card ids exist in both languages, all in neo4: `neo4-100` through `neo4-113`. A bare TCGdex card id is not a primary key for a bilingual catalog. Scope every catalog id by language (`en` + `neo4-100` vs `ja` + `neo4-100`). The brief's `catalog_card_id` text needs that language either in the key or in a unique `(language, catalog_card_id)` constraint. Collection rows already carry `language`; the catalog side must too, or a resync of one language will overwrite the other.

## Rate limits, request counts, time

Docs (https://tcgdex.dev/faq): no auth, no published hard rate limit, "please be considerate", cache locally. Live headers on set list, set detail, and card detail included `ETag` and `Cache-Control: no-cache, no-store, must-revalidate`. No `X-RateLimit-*`, `RateLimit-*`, or `Retry-After` on any response inspected.

Measured: 404 set-detail GETs at concurrency 6 finished in 17.7 s, 399×200 and 5×404 (the unencoded `+` ids, not throttling). Implied average latency 0.263 s, throughput 22.8 req/s at that concurrency. A conditional GET of `/v2/en/sets` with `If-None-Match: W/"8b59-FmedVib2yUiaVn+PINM5rcPvoko"` returned **304 Not Modified** and the same ETag. So ETags work even though Cache-Control says no-store.

What a full metadata sync actually has to request:

- 2 set-list calls.
- 404 set-detail calls (220 EN + 184 JA).
- Card-detail calls for every brief that exists: 23736 EN + 12781 JA = 36517. Empty shells add nothing. Set detail is not enough for rarity, variants, or price.

Do not also download images in Phase 1. Store the base URL and let the browser request `high.webp` / `low.webp` from the CDN. Image downloads are a Phase 2 index-build concern (Pokeum does them because recognition needs pixels).

Time, extrapolated from the 0.263 s latency, not re-measured at higher concurrency:

- card details at concurrency 6: 26.7 min
- at 8: 20.0 min
- at 12: 13.3 min

Set details were 17.7 s at concurrency 6. Pokeum's constant comment says they "verified at 32" and ship `SYNC_CONCURRENCY = 12`. I did not test 12 or 32, and I did not see a 429, so I am not claiming 32 is safe. Recommend concurrency 8, three retries with 1s/2s/4s backoff, and stop-and-halve if a 429 or `Retry-After` ever appears. Identify the client with a stable User-Agent. The phone must not hold the connection open for the whole run; persist progress per set (the brief already requires that).

Pokeum's sync (`app/reference/sync.py`) does exactly this shape when `fetch_details=True` (the default): list sets, GET each set, GET each card on a pool of 12, then download images. `fetch_details=False` skips per-card calls and therefore stores no variant flags and no rarity. That cheaper mode is not enough for us.

## Incremental resync

There is no catalog-wide `updated` watermark.

What exists:

- Set-list ETag. A 304 means the brief list is byte-identical, which means no set was added and no list-level `cardCount`/`name`/`logo`/`symbol` changed. It does **not** mean card text or prices are unchanged, because those are not in the list payload.
- Set-detail responses also carry `ETag` (seen on the bulk pull). Conditional GET on set detail was not tested. Worth trying; if 304 works, unchanged sets can be skipped without parsing.
- Card `updated` (all 44 cards). Docs say it excludes pricing. A change to attacks, rarity, or image should move it. A price-only change will not.
- `pricing.cardmarket.updated` and `pricing.tcgplayer.updated` are the price watermarks. On the sample they were `2026-10-30T22:54:33.134Z` (cardmarket, same instant on many cards — a batch feed) and about 16 days older for tcgplayer. Compare these, not the card `updated`, before writing a PriceSnapshot.
- `cardCount.total` deltas, which is all Pokeum uses (`_set_is_current` compares the stored `card_count_total` column to the list brief). That misses price updates, image backfills, variant corrections, and the empty-shell case: a shell has a non-zero advertised total and zero cards, so storing the advertised total marks it "current" forever even after TCGdex fills `cards`. It also misfires on `mfb` / `tk-sm-l` / `web1`, where total already disagrees with the array.

Recommended check, in order:

1. Conditional GET the set list. On 304, skip set discovery. Still run a price pass on a schedule, because prices are not in the list.
2. For each set, conditional GET set detail if you stored its ETag; otherwise GET it. Diff the set of card ids (not `cardCount.total`) against what you stored. New or missing ids → fetch those card details. Empty `cards` with a non-zero total is "not yet published", not "synced".
3. For cards whose set detail changed, GET card detail and upsert. Compare `updated` to skip a no-op write.
4. Price refresh is separate and slower: re-GET card detail (pricing is not a separate endpoint — markets docs confirm it is embedded) and write a PriceSnapshot only when `pricing.*.updated` or the price payload changed. Do not block catalog search on this pass.

## `@tcgdex/sdk`

Registry `https://registry.npmjs.org/@tcgdex/sdk/latest` on 2026-10-30: version **2.9.0**, MIT, `engines.node >= 18`, types at `./dist/tcgdex.d.ts`, ESM and CJS. Dependencies: `@cachex/memory`, `@cachex/web-storage`, `@dzeio/object-util`. Docs: https://tcgdex.dev/sdks/javascript. Install: `npm i @tcgdex/sdk`.

It is a thin client: `new TCGdex('en')`, `card.get(id)`, `set.get(id)`, `card.list(Query)`, `getImageURL('high','webp')`, in-memory TTL cache. `card.list()` returns briefs. `set.cards[i].getCard()` is another HTTP call per card. The SDK docs themselves say set listing does not support filtering. There is no bulk full-card download and no ETag/resume API.

Opinion: do not use it for the sync. A resumable CLI/`route` job wants explicit fetch, ETag, retry, and a progress row in SQLite. The SDK's cache dies with the process and hides the status code. Node 22 can call `fetch` directly; validate with the zod schemas this repo already plans to own. The SDK is fine for a one-off script or a unit-test fixture, and its image helper matches the card URL rule above — but it will not fix the univ symbol 404, and its types will lag `variants_detailed` (the FAQ still calls that field unreleased). Pinning an extra three packages to save a URL join is not worth it.
