# Variants and pricing (Stage A)

Sample: 44 card-detail responses, all HTTP 200, fetched with curl on 2026-10-30 from `https://api.tcgdex.net/v2/{lang}/cards/{id}`.

EN (34): `base1-1`, `base1-4`, `basep-1`, `base5-4`, `gym1-1`, `neo1-1`, `neo1-9`, `lc-2`, `ecard2-1`, `ecard2-50a`, `ecard2-H01`, `pop1-1`, `ex1-1`, `ex1-100`, `dp1-1`, `hgss1-1`, `bw1-1`, `bw1-115`, `xy1-1`, `sm1-1`, `sm1-149`, `swsh3-1`, `swsh3-136`, `swsh3-201`, `swshp-SWSH001`, `cel25-25`, `sv01-001`, `sv01-198`, `sv01-258`, `sv08.5-001`, `svp-001`, `mep-001`, `A1-001`, `P-A-001`.

JA (10): `PMCG1-001`, `neo1-001`, `web1-001`, `SM1S-001`, `S12a-001`, `SV1S-001`, `SV2a-001`, `SV2a-210`, `SV-P-001`, `M-P-001`.

Categories in the sample: 38 Pokemon, 3 Trainer (`sm1-149`, `sv01-198`, `P-A-001`), 3 Energy (`swsh3-201`, `sv01-258`, `SV2a-210`). Eras covered: WotC base/gym/neo, e-Card, ex, POP, DP, HGSS, BW, XY, SM, SWSH, SV, SV promo, MEP promo, TCG Pocket, JA from PMCG through MEGA promo. This is a stratified sample of famous and awkward cards, not a random draw of the 36517 briefs. Rates below are sample rates. JA and Pocket are over-represented relative to a random EN card, and chase cards are over-represented relative to commons. Do not quote them as catalog-wide percentages.

`GET /v2/en/variants` returned exactly:

```
["firstEdition","holo","normal","reverse","wPromo"]
```

A filtered list `GET /v2/en/cards?variants.wPromo=eq:true&pagination:page=1&pagination:itemsPerPage=3` returned `[]`. None of the 44 cards had `variants.wPromo: true`. The EN set `wp` ("W Promotional") is an empty shell. The flag is in the schema. I found no live card that uses it.

## Two different variant objects

`variants` is a boolean availability map. Present on every card, always these five keys:

```
{"firstEdition": false, "holo": false, "normal": true, "reverse": true, "wPromo": false}
```

True counts in the 44: normal 25, holo 21, reverse 12, firstEdition 6, wPromo 0. These booleans are what Pokeum stores. They are not a price key. `base1-4` is `holo+firstEdition` and still has four priced (or unpriced) printings underneath.

`variants_detailed` is the print list. Present on every card, including Pocket (`A1-001` has one row and no prices). Row keys seen: `type` (78/78), `size` (78/78), `variantId` (78/78), `thirdParty` (59), `pricing` (59), `stamp` (13), `subtype` (9), `foil` (5).

`type` values seen: `normal` (30 rows), `holo` (33), `reverse` (15). No other type.
`size` values seen: `standard` (77), `jumbo` (1, `swshp-SWSH001`).
`subtype` values seen: `unlimited`, `shadowless`, `1999-2000-copyright`, `no-rarity`.
`foil` values seen: `pokeball`, `masterball`, `gold`.
`stamp` values seen: `1st-edition`, `1st edition` (space, on `web1-001` only), `1st-edition-error`, `pikachu-tail`, `grey-star`, `set-logo`, `set-logo`+`staff`, `25th-celebration`.

`variantId` is not unique per card. `normal` rows on `swsh3-136` and `sv08.5-001` both use `endfynwn4n10gzq`. `A1-001` uses `"generated"`. Do not use it as a primary key. It identifies a variant *kind* in their pipeline, and sometimes it is a placeholder.

## Real rows

Modern, two prints, prices copied onto both rows (`swsh3-136` Furret). Both rows carry the same `thirdParty` ids and the same tcgplayer object, which itself has both `normal` and `reverse-holofoil`:

```
{"type":"normal","size":"standard","thirdParty":{"cardmarket":483559,"tcgplayer":219333},"variantId":"endfynwn4n10gzq",
 "pricing":{"cardmarket":{"unit":"EUR","updated":"2026-10-30T22:54:33.147Z","idProduct":483559,"avg":0.06,"low":0.02,"trend":0.04,"avg1":0.02,"avg7":0.05,"avg30":0.06,"avg-holo":0.22,"low-holo":0.08,"trend-holo":0.23,"avg1-holo":0.18,"avg7-holo":0.23,"avg30-holo":0.24},
            "tcgplayer":{"unit":"USD","updated":"2026-10-14T22:55:05.165Z",
              "normal":{"productId":219333,"lowPrice":0.02,"midPrice":0.25,"highPrice":25.27,"marketPrice":0.27,"directLowPrice":null},
              "reverse-holofoil":{"productId":219333,"lowPrice":0.17,"midPrice":0.43,"highPrice":19.8,"marketPrice":0.44,"directLowPrice":0.37}}}}
```

The sibling `type:"reverse"` row is the same payload with a different `variantId` (`cm4kqul3x1bwlz1f`). The price discriminator is the tcgplayer key, not which row you opened.

WotC, four holo rows (`base1-4` Charizard):

- `type=holo subtype=unlimited` — cardmarket 273699 avg 458.1 EUR, tcgplayer key `holofoil` (product 42382, marketPrice 954.65 USD). `avg-holo` is null. Here `avg` is the holo price.
- `type=holo subtype=shadowless stamp=["1st-edition"]` — cardmarket 660224 avg 3400 EUR, tcgplayer **null** even though `thirdParty.tcgplayer` is 106999.
- `type=holo subtype=shadowless` (no stamp) — same cardmarket product 660224, same 3400 EUR, tcgplayer null. Shadowless 1st and shadowless unlimited are not priced apart.
- `type=holo subtype=1999-2000-copyright` — `thirdParty` absent, both prices absent.

`base1-1` (Alakazam) is the same four-way split. `base5-4`, `gym1-1`, `neo1-1`, `neo1-9` put 1st Edition in `stamp:["1st-edition"]` with no subtype, and the tcgplayer object on that row contains **both** `1st-edition-holofoil` and `unlimited-holofoil`. Example `neo1-9`: one row, two USD prices. Reading "the" price off the row without picking a key will grab the wrong one if you take the first key.

Prismatic / 151 ball foils (`sv08.5-001`, and the same pattern on `ja/SV2a-001`):

- `type=reverse foil=pokeball` — own cardmarket id 806408, `avg` null, `avg-holo` 0.32 EUR. tcgplayer product 610536, and the only price key is `holofoil`, not `reverse-holofoil`.
- `type=reverse foil=masterball` — cardmarket 806409, `avg-holo` 1.69 EUR, tcgplayer key `holofoil` on product 610637.
- The plain `type=reverse` row still uses `reverse-holofoil` on the base product.

So "reverse" does not mean the key `reverse-holofoil` once `foil` is set.

Other stamps, prices often missing on the tcgplayer side:

- `basep-1` stamps `1st-edition-error`, `pikachu-tail`, `grey-star`: each has a tcgplayer product id, price object null, no cardmarket.
- `mep-001` stamps `set-logo` and `set-logo`+`staff`: cardmarket avg 19.67 and 36.2 EUR, tcgplayer null. Card also has no image.
- `swshp-SWSH001` `size=jumbo` stamp `25th-celebration`: cardmarket avg 2.15 EUR, tcgplayer null.
- `swsh3-201` `foil=gold` (secret energy): tcgplayer key `holofoil`, cardmarket `avg` 3.88 (`avg-holo` null).
- `web1-001` stamp `"1st edition"` (space, not hyphen): no thirdParty, no prices.
- `PMCG1-001` `subtype=no-rarity`: tcgplayer id present, price object null, no cardmarket.

## tcgplayer keys

Seen as price objects (a dict of low/mid/high/market/directLow), across root `pricing.tcgplayer` and `variants_detailed[].pricing.tcgplayer`:

- `normal` (19 rows that contained it)
- `holofoil` (35)
- `reverse-holofoil` (26)
- `1st-edition-holofoil` (12)
- `unlimited-holofoil` (12)

Not seen in this sample, but listed on https://tcgdex.dev/reference/card: `1st-edition`, `unlimited` (the non-holo forms). Keep them in the mapper so a later card doesn't crash. Don't invent prices for them.

Each price object:

```
{"productId":219333,"lowPrice":0.02,"midPrice":0.25,"highPrice":25.27,"marketPrice":0.27,"directLowPrice":null}
```

Any of the five numbers can be null (`directLowPrice` often is). `productId` matches `thirdParty.tcgplayer` when both exist. Unit is the string `"USD"`. `updated` is an ISO string, not the Number the reference page claims. Docs' example key `reverse` was not seen; the live key is `reverse-holofoil`.

Display price, when a key exists: `marketPrice`, else `midPrice`, else null. Never average low and high. Never fill from another key.

## cardmarket keys

Every usable cardmarket object had the same keys: `updated`, `unit` (`"EUR"`), `idProduct`, `avg`, `low`, `trend`, `avg1`, `avg7`, `avg30`, `avg-holo`, `low-holo`, `trend-holo`, `avg1-holo`, `avg7-holo`, `avg30-holo`.

There is no `reverse` key and no `1st-edition` key. Foil vs non-foil is the `-holo` suffix on the same object. 1st Edition vs unlimited vs shadowless is a different `variants_detailed` row with a different `idProduct`, or it isn't split at all (shadowless 1st and shadowless unlimited share 660224 on Charizard).

Which number to store:

- If `avg` is a number and `avg-holo` is null, `avg` is the price of that row's printing (WotC holo, gold secret). Also store `low` and `trend` beside it.
- If both `avg` and `avg-holo` are numbers, `avg` is non-foil and `avg-holo` is foil. This is the modern normal/reverse split (`swsh3-136`: 0.06 vs 0.22). It does **not** distinguish reverse holo from a holo rare. A card that is both holo and reverse still has one foil EUR number.
- If `avg` is null and `avg-holo` is a number, use `avg-holo` (pokeball, masterball).
- If both are null, the row has no EUR price. Store null.

`idProduct` is `thirdParty.cardmarket`. Root `pricing.cardmarket` is one of these objects, not a merge. For modern cards it matches the duplicated blob on every row. For WotC it matches one printing (Charizard's root object is the unlimited product, not the shadowless one). Do not read the root object when the user picked a different print.

## Proposed enum

Two stored layers.

1. Availability, copied off `variants`, not an owned-card choice: `normal`, `holo`, `reverse`, `first_edition`, `w_promo`. Booleans. `w_promo` stays false until a card proves otherwise.

2. Owned-card `print_variant`, the thing the user confirms and the thing PriceSnapshot points at. Text, not a float. Proposed values, mapped only where the sample shows the path:

```
print_variant              match a variants_detailed row by                         tcgplayer key            cardmarket field
normal                     type=normal, no foil, no stamp, size=standard            normal                   avg
holofoil                   type=holo, no subtype, no stamp, no foil, size=standard  holofoil                 avg if avg-holo is null, else avg-holo
reverse_holofoil           type=reverse, no foil                                    reverse-holofoil         avg-holo
first_edition_holofoil     stamp contains "1st-edition" AND type=holo               1st-edition-holofoil     that row's avg
unlimited_holofoil         subtype=unlimited, or the unlimited key on a 1st-ed row  unlimited-holofoil       that row's avg (often the same product as 1st ed — see below)
shadowless                 subtype=shadowless, no stamp                             (none in sample; null)   that row's avg
shadowless_first_edition   subtype=shadowless AND stamp 1st-edition                 (none in sample; null)   same product as shadowless on base1-4; do not invent a second price
pokeball_reverse           type=reverse AND foil=pokeball                           holofoil on THAT product avg-holo
masterball_reverse         type=reverse AND foil=masterball                         holofoil on THAT product avg-holo
gold_holofoil              foil=gold                                                holofoil                 avg
jumbo                      size=jumbo                                               (null in sample)         that row's avg
stamped                    any other stamp (grey-star, pikachu-tail, staff,        (usually null)           that row's avg if it is a number, else null
                           set-logo, 25th-celebration, 1st-edition-error,
                           "1st edition" with a space)
w_promo                    variants.wPromo is true                                  unknown                  unknown
```

Rules the mapper has to follow or it will store the wrong cents:

- Pick the key by name. On `neo1-9` the 1st-edition row contains both `1st-edition-holofoil` and `unlimited-holofoil`. First-key wins is a bug.
- Do not fall back from a missing key to a sibling key. Shadowless has a tcgplayer product id and a null price object. The unlimited `holofoil` price is a different card. Store null.
- Pokeball/masterball use the key `holofoil` on a different product id. Mapping them to `reverse-holofoil` on the base product prices a $0.20 reverse as if it were the masterball.
- Cardmarket `avg` vs `avg-holo` is not 1st-edition vs unlimited. Those are separate rows. If two rows share `idProduct`, they share a price; store the same cents on both and let the UI say so, or store the price once and point both variants at it. Don't split one number into two invented prices.
- `stamp` value `"1st edition"` (space) on `web1-001` is not the same string as `"1st-edition"`. Normalize before matching, or it falls through to `stamped` and loses the 1st-edition mapping. I would normalize hyphen/space/case, then match.
- `subtype=1999-2000-copyright` and `subtype=no-rarity` had no usable price. Map them to `stamped` or to their own enum values with a null price. I would give `1999-2000-copyright` its own value (`copyright_variant`) so a later price fill doesn't get written onto the unlimited row. `no-rarity` can stay `stamped` until more JA rows show up.
- Root `pricing` is a cache of one product. Write PriceSnapshot from the matched row, not from the root, except when the card has a single `variants_detailed` row.

Money: integer cents, currency `USD` or `EUR`, no conversion in Phase 1 (brief). `marketPrice` 0.27 USD → 27 cents. `avg` 458.1 EUR → 45810 cents. Use decimal-safe rounding (half away from zero, or round-half-even — pick one and test it). Null stays null. A price of 0 was not seen; if it appears, store 0, don't treat it as missing.

Which number, if the architect wants one column rather than five: USD `marketPrice`, EUR `trend` (cardmarket's "trend price from charts", which is what their markets page highlights). Also keep `low` / `lowPrice` if it's cheap to store. Historical snapshots should keep the source `updated` timestamp so a resync can skip unchanged feeds.

## Pricing absent

Definition used: a provider is usable only when its object is a dict containing at least one price sub-object (tcgplayer) or at least one numeric avg/low/trend field (cardmarket). A key whose value is null does not count. Product id with a null price object does not count.

Of 44 cards:

- usable tcgplayer: 29
- usable cardmarket: 37
- neither: 6 — `A1-001`, `P-A-001`, `basep-1`, `ja/neo1-001`, `ja/PMCG1-001`, `ja/web1-001`

tcgplayer missing (15): those 6, plus `mep-001`, `svp-001`, and every other JA card in the sample (`SM1S-001`, `S12a-001`, `SV1S-001`, `SV2a-001`, `SV2a-210`, `SV-P-001`, `M-P-001`). 10/10 JA cards had no usable USD price. Several of those still have cardmarket EUR (`SV-P-001` trend 22.69 EUR, `SV1S-001` avg 0.14 EUR, `M-P-001` has a cardmarket id on the row).

cardmarket missing (7): `A1-001`, `P-A-001`, `basep-1`, `gym1-1`, `ja/neo1-001`, `ja/PMCG1-001`, `ja/web1-001`.

`A1-001` is the clean null case:

```
"pricing": {"cardmarket": null, "tcgplayer": null}
"variants_detailed": [{"type":"normal","size":"standard","variantId":"generated"}]
```

`ja/SV1S-001` is the one-market case: cardmarket populated, `"tcgplayer": null` both at the root and on the row, while `thirdParty.tcgplayer` is still `567118`. An id is not a price.

Per-print holes inside cards that do have some price: shadowless and 1999-2000-copyright on `base1-4` / `base1-1` (no USD; shadowless has EUR, copyright has neither); `basep-1` stamp rows (ids, no numbers); `swshp-SWSH001` jumbo (EUR only); `mep-001` staff stamp (EUR only).

Sample estimate, stated as a sample: about 6/44 cards (the ones above) had no price on either market, and about 15/44 had no USD price. The JA slice was 0/10 for USD. A random EN modern common is more likely to have both markets than this sample suggests, because the sample deliberately included Pocket, promos, and JA. A JA-heavy collection will see missing USD prices as the normal case, not the exception. Phase 1 value totals must ignore nulls and must not display 0 for them.

## What not to do

- Don't scrape TCGPlayer, Cardmarket, eBay, or PriceCharting to fill holes. The brief forbids it, and a null is an honest empty state.
- Don't copy Pokeum's four booleans into the owned-card variant. They can't tell unlimited from 1st Edition holofoil, and they can't see pokeball foil at all.
- Don't treat `variants_detailed` order as stable. Match on type + subtype + stamp + foil + size.
- Don't currency-convert. Show USD from tcgplayer and EUR from cardmarket side by side.
