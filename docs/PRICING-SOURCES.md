# Pricing sources (pricing-v2, Phase B/C research)

Checked: 2026-11-08. Every external claim carries its source URL. `UNVERIFIED` means it could not be confirmed from a primary page in this session. Nothing here is wired into the app; the code lives in `packages/core/src/pricing/**` (types, normaliser, sold-summary) and is pure.

Vocabulary used throughout (see `packages/core/src/pricing/types.ts`):

- listing-estimate: derived from what is currently for sale, or a provider-computed blend we cannot audit.
- provider-sale-average: the provider says it averages completed sales; we cannot audit it.
- verified-sale: an individual completed sale we hold a record for. Only `SoldRecord` can be one.

---

## 1. What TCGdex actually ships

Fetched live from `https://api.tcgdex.net/v2/{en|ja}/cards/<id>` on 2026-11-08: `en/swsh3-136` (Furret), `en/sv01-001` (Pineco), `en/base1-4` (Charizard), `en/xy1-1` (Venusaur EX), `en/swsh3-201`, `en/sv08.5-001`, and `ja/SV2a-001`, `ja/SV1S-001`, `ja/SV1a-001` (ids from `https://api.tcgdex.net/v2/ja/sets`). Pricing-only fixtures for five of them are under `packages/core/test/fixtures/tcgdex/pricing-*.json`. Re-run `npx tsx tools/catalog-builder/src/pricing-probe.ts [lang/id ...]` for a live table.

### 1.1 Shape of `pricing`

```
pricing: {
  cardmarket: { updated, unit: "EUR", idProduct,
                avg, low, trend, avg1, avg7, avg30,
                avg-holo, low-holo, trend-holo, avg1-holo, avg7-holo, avg30-holo } | null,
  tcgplayer:  { updated, unit: "USD",
                <priceKey>: { productId, lowPrice, midPrice, highPrice, marketPrice, directLowPrice }, ... } | null
}
```

Observations (all confirmed in the payloads above):

- Cardmarket: all 12 price keys are always present as keys; values may be `null` (foil keys on cards with no foil sales, e.g. `avg-holo`/`low-holo` null on base1-4 and xy1-1) or `0` (`trend-holo: 0` on ja/SV1S-001 and ja/SV1a-001 while `avg-holo` is null, so 0 means "no data", not a price of zero). One `idProduct` per card (shared by every variant row).
- Cardmarket splits only non-foil vs foil (`-holo` suffix). It cannot say whether "foil" is holo or reverse holo.
- TCGplayer: one object per price key actually listed (`normal`, `holofoil`, `reverse-holofoil`, 1st-edition/unlimited keys). swsh3-136 has `normal` + `reverse-holofoil`; base1-4 has only `holofoil` even though the card has four print rows; xy1-1 has `holofoil` although `variants` says `normal: true` (the key names TCGplayer's finish, not TCGdex's variant flags). All five sub-fields are present as keys; `directLowPrice` is often `null` (sv01-001 both variants) .
- Japanese cards (`ja`) carry Cardmarket only; `tcgplayer` is `null` on all three JA cards checked. JA prices are therefore EUR-only. Whether the Cardmarket product behind a JA `idProduct` is the Japanese printing: UNVERIFIED (not confirmable from the payload).
- `variants_detailed[]` rows may each carry their own copy of `pricing` plus `thirdParty: {cardmarket, tcgplayer}` ids and `variantId`. swsh3-136 duplicates the identical card-level pricing in every row (the two rows are not priced separately); sv01-001 and xy1-1 rows have no per-row pricing; base1-4 has pricing on 3 of 4 rows. Do not read a per-row `pricing` as a per-variant price without comparing against the key names.
- Refresh stamps: every `updated` observed (Cardmarket and TCGplayer, across 9 cards, EN and JA) was `2026-11-07T23:49:17Z`..`23:49:32Z`, i.e. one nightly batch about 12-20h before the fetch. TCGdex's docs advertise hourly TCGplayer updates; we did not observe sub-daily stamps. Plan on daily.
- Pricing is absent/null for some cards (older EX / full-art, very new releases, regional exclusives) per the FAQ.
- TCGdex FAQ admits some cards share an external listing with another printing (regular card vs Special Illustration Rare showing the same price) and that marketplace ids may be wrong; `variants_detailed` is their fix, still rolling out. Source: https://tcgdex.dev/faq

### 1.2 What the builder stores vs drops

Builder path: `packages/core/src/catalog/tcgdex/prices.ts` -> `tools/catalog-builder/src/build-db.ts` -> `catalog_latest_prices` (columns `low_cents, mid_cents, high_cents, market_cents, trend_cents`, plus `provider_variant_key`, `source_updated_at`, `currency`).

| Provider field | Stored today as | Status |
|---|---|---|
| tcgplayer lowPrice / midPrice / highPrice / marketPrice | low / mid / high / market | stored |
| tcgplayer directLowPrice | n/a | DROPPED |
| tcgplayer productId | embedded in `provider_variant_key` | partially kept |
| tcgplayer updated, unit | `source_updated_at`, `currency` | stored |
| cardmarket low, low-holo | low | stored |
| cardmarket avg, avg-holo | mid (loses the "this is a sale average" meaning) | stored, mislabelled as mid |
| cardmarket trend, trend-holo | trend | stored |
| cardmarket avg1, avg1-holo | n/a | DROPPED |
| cardmarket avg7, avg7-holo | n/a | DROPPED |
| cardmarket avg30, avg30-holo | n/a | DROPPED |
| cardmarket idProduct | embedded in `provider_variant_key` | partially kept |
| per-row `variants_detailed[].thirdParty`, `variantId` | n/a | DROPPED (not needed for prices) |

The pack has no `kind` per value, so the app cannot tell a Cardmarket 30-day sales average (`avg`, stored as `mid`) from a TCGplayer median listing (`mid`). That is the main modelling gap for "average sold price" claims.

### 1.3 Provider definitions (quoted)

From TCGdex Card reference https://tcgdex.dev/reference/card (checked 2026-11-08):

- TCGplayer variant fields: `lowPrice` "Lowest available price"; `midPrice` "Median market price"; `highPrice` "Highest available price"; `marketPrice` "Current market price"; `directLowPrice` "Lowest direct seller price".
- Cardmarket: `avg` "Average selling price (non-foil)"; `low` "Lowest market price (non-foil)"; `trend` "Trend price from charts (non-foil)"; `avg1` "Average price (last 24 hours)"; `avg7` "Average price (last 7 days)"; `avg30` "Average price (last 30 days)"; `-holo` variants are the same for foil.
- `updated`: "Indicate when is the last time it was fetched".

TCGdex's own words never say "sales" except for `avg` ("selling price"). Treating avg1/avg7/avg30 as 24h/7d/30d averages of completed Cardmarket sales is the standard reading of Cardmarket's price guide, but Cardmarket's primary documentation could not be fetched (the API doc pages returned nothing parseable and the API is closed, section 2): UNVERIFIED at source. Our normaliser labels them `provider-sale-average` (never `verified-sale`) and `low`/`trend` as `listing-estimate`.

From TCGplayer help https://help.tcgplayer.com/hc/en-us/articles/213588017-TCGplayer-Market-Price: Market Price "shows you the value of a collectible based upon actual recent sales". TCGdex relays it as "Current market price". We label it `listing-estimate` anyway: it is a provider-computed figure we cannot audit, and TCGplayer's exact window/method is not given in the part we read (UNVERIFIED).

### 1.4 Licence, attribution, cadence, limits

- Database licence: MIT, "not produced, endorsed, supported or affiliated with Nintendo or The Pokémon Company". Source: https://github.com/tcgdex/cards-database (README "Licenses", LICENSE "MIT License, Copyright (c) 2021 TCGdex").
- Pricing redistribution rights: TCGdex relays TCGplayer and Cardmarket figures. No page we read states that TCGdex has a licence from either marketplace for downstream commercial redistribution, and the MIT licence covers TCGdex's database, not necessarily third-party price data. UNVERIFIED. This is the biggest legal open question (see report).
- Attribution: no attribution requirement found on https://tcgdex.dev/faq, https://tcgdex.dev/markets-prices or the repo README. UNVERIFIED beyond that. `THIRD_PARTY_NOTICES.md` already lists TCGdex assets.
- Auth / rate limits: "No. The TCGdex API is free to use and requires no API key." "There are no published hard rate limits, but please be considerate. For bulk data needs, cache responses locally." Source: https://tcgdex.dev/faq
- Refresh (docs): "Updated hourly (TCGPlayer) to daily (Cardmarket)". Cardmarket "Update frequency: Daily"; TCGplayer "Hourly to daily". Source: https://tcgdex.dev/markets-prices. Observed: one nightly stamp (~23:49 UTC) for both.

---

## 2. Other sources (document, not integrated)

Legend: SALES = individual completed sales; AVG = provider sale averages; LIST = listings / provider blend.

| Source | Availability (checked 2026-11-08) | Access requirements | Licence / commercial restrictions | Refresh / limits | Coverage | Sales vs listings | Cost |
|---|---|---|---|---|---|---|---|
| TCGdex (baseline) | Open | None | MIT for DB; third-party price rights UNVERIFIED | Daily observed; no hard limit | EN + JA; raw only; Cardmarket (EN+JA), TCGplayer (EN only) | AVG (Cardmarket avg1/7/30) + LIST | Free |
| eBay Browse API | Open to approved developers | eBay developer account; Buy APIs need an additional licence and an Application Growth Check for production | eBay API License Agreement; eBay Content may be shown only while publicly available (delete when no longer public) | Default 5,000 calls/day for Browse; higher via Growth Check | Global listings; no sold data | LIST only (active listings) | Free (EPN/affiliate terms apply) |
| eBay Marketplace Insights API | Limited Release; "not open to new users at this time"; "cannot be granted upon request" | Approved by eBay business units; category whitelisting; scope `buy.marketplace.insights` | Restricted-API terms: no bulk download or API redistribution of the data; use in pricing tools only with eBay consent | Max 10,000 items per query; 90-day history | Sold items, by keyword/GTIN/ePID/category, supported sites only | SALES (up to 90 days) | Unknown; no public pricing |
| PriceCharting API | Open to paying subscribers | Paid subscription (Legendary, $49/month on the pricing page); 40-char token | "licensed for internal use only"; displaying in an app/service used by others needs a commercial licence and written permission; cache OK, must purge after subscription ends | 1 call/second; CSV once per 24h (CSV generated every 24h) | Cards incl. graded buckets (PSA/BGS/CGC/SGC/TAG/ACE grades); current values only: "Historic prices and historic sales are not supported" | Provider-computed values (basis not stated in the API doc) | $49/month + commercial licence (price not published) |
| TCGplayer API | Closed to new access: "We are no longer granting new API access at this time." | Existing approved keys only | TCGplayer API Terms: approved purposes only, required attribution notice, audit rights | n/a | n/a | n/a | n/a |
| Cardmarket API | Closed: "Currently, we are not accepting applications for access to the Cardmarket API." | Existing dedicated-app credentials only; credentials may not be shared with third-party apps | n/a | n/a | n/a | n/a | n/a |
| Pokemon Price Tracker | Open | Self-serve account and API key | Terms s.6: commercial use (any revenue-generating app, displaying prices in a commercial product) requires Business or Enterprise; no resale of raw data. The pricing page also lists "Commercial use license" under Free and API tiers while its comparison table says "Not included" for both: contradictory, treat as NOT licensed below Business | Free 100 credits/day, 60 req/min; API $9.99: 20,000 credits/day; Business $99: 200,000 credits/day, 500 req/min | EN, "Japanese card data", sealed; RAW and PSA prices; Cardmarket EUR (beta, paid tiers) | Claims "Graded sales from eBay + Fanatics Collect"; upstream rights to that data UNVERIFIED | Free / $9.99 / $99 / $300 per month |
| JustTCG | Open | Self-serve key, no application | Paid plans carry a commercial licence (display to users, cache while subscribed, derive analytics); no reselling raw feed, no bulk exports, no competing API. Free tier is non-commercial | Free: 1,000 calls/month, 100/day, 10/min, 20 cards/request; Starter $19: 10,000/month; Pro $49: 50,000/month | Pokémon listed among games; Japanese Pokémon and graded coverage UNVERIFIED; condition-level prices | "blended with real sales from partner game stores" (not individual sale records) | Free / $19 / $49 / $149 per month |
| Flipzi (flipzi.io) | Open, third party | Self-serve key | Commercial use on paid plans; no redistribution as a data product. Free tier: no commercial grant, no sold comps, no graded prices | Free 500 units/month, 5 req/min | "17 TCGs plus Japanese Pokémon" (their statement) | Sold comps and graded prices on paid tiers per their comparison page; not verified | EUR 19.99-249/month |
| Scrydex | Exists (https://scrydex.com) | UNVERIFIED (pricing page is JavaScript-rendered; could not read plans or terms) | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Pokedata, Collectr | NOT CHECKED in this session | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED |

Not recommended: services that scrape TCGplayer pages and resell the output (for example api.sh's TCGplayer endpoint, https://api.sh/tcgplayer-api). That route reintroduces exactly the access/licensing problem TCGplayer closed its API over, and we were told not to bypass access controls.

Sources (all checked 2026-11-08):

- eBay Marketplace Insights overview: https://developer.ebay.com/api-docs/buy/marketplace-insights/static/overview.html
- eBay Buy filters note ("restricted and not open to new users at this time"): https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html
- eBay Partner Network developer questionnaire ("access to Order API | Offer API | Marketplace Insights API cannot be granted upon request"): https://partnernetwork.ebay.com/page/developer-questionnaire
- eBay Buy application steps: https://developer.ebay.com/develop/get-started/get-started-on-a-buying-application
- eBay call limits: https://developer.ebay.com/develop/get-started/api-call-limits
- eBay API licence: https://developer.ebay.com/develop/get-started/api-license-agreement
- eBay Browse API (listings): https://developer.ebay.com/develop/api/buy/browse_api.md
- PriceCharting API docs: https://www.pricecharting.com/api-documentation ; terms: https://www.pricecharting.com/page/terms-of-service ; plans: https://www.pricecharting.com/pricecharting-pro
- TCGplayer API getting started: https://docs.tcgplayer.com/docs/getting-started ; terms: https://help.tcgplayer.com/hc/en-us/articles/360061115874-TCGplayer-API-Terms-Conditions
- Cardmarket API help: https://help.cardmarket.com/en/cardmarket-api
- Pokemon Price Tracker: https://pokemonpricetracker.com/pricing , https://pokemonpricetracker.com/terms
- JustTCG: https://justtcg.com/pricing , https://justtcg.com
- Flipzi comparison: https://flipzi.io/api/compare/justtcg

Caveat on eBay: the Marketplace Insights overview itself says "available only to select developers approved by business units"; two other eBay pages say it is closed to new users / not grantable on request. We treat it as unavailable. eBay's licence also says "Restricted APIs" data cannot be distributed in bulk, which would conflict with shipping a pack to every device.

---

## 3. Interfaces added (pure, tested, not wired)

- `packages/core/src/pricing/types.ts`: `MarketQuote`, `SoldRecord`, `SoldSummary`, `PriceProvider`, `ProviderCapabilities`. Deviation from the brief: `QuoteType` also includes `'avg'` (Cardmarket's all-time/overall average), because mapping it to `'mid'` (as the builder does) would mislabel a sale average as a listing median.
- `packages/core/src/pricing/sold-summary.ts`: `summariseSold(records, {windowDays, now, outlier})`. Buckets by raw | graded company+grade, and by currency; drops out-of-window (window is `(now - days, now]`), future and unparseable dates, drops `bundle: true`, trims IQR (1.5x fence) or MAD (modified z > 3.5) outliers when n >= 4, then mean/median. Any record whose `kind !== 'verified-sale'` throws (the `kind` literal also makes listings a compile error).
- `packages/core/src/pricing/tcgdex-normalise.ts`: `normaliseTcgdexPricing(pricing, {language, cardId, observedAt})` -> `MarketQuote[]`. Cardmarket `avg/avg1/avg7/avg30` (+ `-holo`) = `provider-sale-average`; Cardmarket `low`/`trend` and every TCGplayer field = `listing-estimate`. Null, invalid, negative and 0 values yield no quote; a block whose `unit` is not the expected currency is dropped.
- Tests: `packages/core/test/pricing-sold-summary.test.ts`, `packages/core/test/pricing-tcgdex-normalise.test.ts` (real payloads in `packages/core/test/fixtures/tcgdex/pricing-*.json`).
- `tools/catalog-builder/src/pricing-probe.ts`: read-only network probe; imports nothing from the build pipeline.
