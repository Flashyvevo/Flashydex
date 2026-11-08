# sonnet-price-sources report

Branch pricing-v2. No commits, no installs. Touched only: `docs/PRICING-SOURCES.md`, `packages/core/src/pricing/**`, `packages/core/test/pricing-*.test.ts`, `packages/core/test/fixtures/tcgdex/pricing-*.json` (5 new files, <1.1 KB each), `tools/catalog-builder/src/pricing-probe.ts`, this report. Temporary files under `.agent/tmp-cards/` (raw fetched cards) were left in place; delete or keep git-ignored.

Full write-up with source URLs and dates: `docs/PRICING-SOURCES.md`.

## Summary

| Source | Usable now? | Sales or listings | Cost | Verdict |
|---|---|---|---|---|
| TCGdex (current) | Yes, no key | Cardmarket avg1/7/30 sale averages + listing estimates | Free | Keep; widen what we store |
| eBay Marketplace Insights | No: closed to new users, not grantable on request | Real sold items (90 days) | Unknown | Not available |
| eBay Browse API | Yes with Buy API licence + Growth Check | Active listings only | Free | Not a sold-price source |
| PriceCharting | Yes, paid; app display needs a separate commercial licence | Provider-computed, graded buckets, current only | $49/mo + licence | Best graded data, blocked on licence |
| TCGplayer API | No: "no longer granting new API access" | n/a | n/a | Closed |
| Cardmarket API | No: "not accepting applications" | n/a | n/a | Closed |
| Pokemon Price Tracker | Yes self-serve; commercial needs Business | Claims eBay + Fanatics graded sales, EN+JA | $99/mo for commercial | Candidate; upstream rights UNVERIFIED |
| JustTCG | Yes self-serve; paid plans carry commercial licence | Blend incl. partner-store sales; JA/graded UNVERIFIED | $19-149/mo | Candidate for raw EN |
| Scrydex, Pokedata, Collectr | Not verified | UNVERIFIED | UNVERIFIED | Open item |

Key finding: the marketplaces that actually hold sales (TCGplayer, Cardmarket) have closed their APIs, and eBay's sold-data API is closed. The only individual-sale sources are third-party aggregators, whose rights to that data we cannot verify.

## Fields TCGdex has that the builder DROPS (input for a future builder change; builder untouched)

- cardmarket `avg1`, `avg7`, `avg30` and `avg1-holo`, `avg7-holo`, `avg30-holo` (6 fields, the only "recent sales" signal TCGdex has)
- tcgplayer `directLowPrice`
- Partially kept (only inside `provider_variant_key`): cardmarket `idProduct`, tcgplayer `productId`
- Mislabelled, not dropped: cardmarket `avg`/`avg-holo` is stored in the `mid` column, indistinguishable from TCGplayer median listing `mid`. There is no per-value `kind`.

Probe confirmation (live, 2026-11-08): base1-4 has avg7=312.04 EUR, avg30=430.3 EUR, directLowPrice=1499.09 USD, all dropped today. JA cards carry Cardmarket only (tcgplayer is null); `trend-holo: 0` means no data.

## Recommended Phase B field list (TCGdex only)

1. Keep: tcgplayer low/mid/high/market; cardmarket low/trend (+ holo twins).
2. Add: cardmarket avg1, avg7, avg30 and holo twins; cardmarket avg (+holo) as its own `avg` quote type, not `mid`; tcgplayer directLow.
3. Store a `kind` per value (`listing-estimate` vs `provider-sale-average`), using `normaliseTcgdexPricing` as the reference mapping.
4. Treat Cardmarket 0 as null. Keep `source_updated_at` per provider block; plan on a daily refresh (all observed stamps were the same nightly batch ~23:49 UTC).
5. Keep `idProduct`/`productId` as explicit columns instead of inside `provider_variant_key`.
6. UI copy must say "Cardmarket 30-day average (EUR)" or "TCGplayer market (USD)", never "sold price".

## Phase C options, ranked by (legal availability, cost, sales-vs-listings)

1. Stay on TCGdex and label honestly (available, free, sale averages only for Cardmarket EUR). Lowest legal risk, assuming the redistribution question below resolves.
2. JustTCG Starter/Professional ($19-49/mo): self-serve, written commercial licence including display + caching. Gap: raw only as far as we can see, JA and graded UNVERIFIED, "partner-store sales" are not individual records.
3. Pokemon Price Tracker Business ($99/mo): covers JA, PSA graded, and claims eBay/Fanatics graded sales. Commercial licence exists at Business; upstream eBay data rights UNVERIFIED, and their pricing page contradicts their terms on lower tiers.
4. PriceCharting Legendary ($49/mo + separate commercial licence by email): best graded coverage but "internal use only" until a licence is signed; no sales history.
5. eBay Marketplace Insights, TCGplayer API, Cardmarket API: unavailable. Revisit only if the owner has an existing relationship.

Rejected: scraping-as-a-service for TCGplayer data; scraping any site ourselves.

## Open questions for the owner

1. Legal: does TCGdex have the right to pass TCGplayer/Cardmarket figures on for commercial redistribution inside an App Store app, and do we need written confirmation from TCGdex? Nothing we read says either way.
2. Are the Cardmarket products behind JA `idProduct` the Japanese printings? Needs a spot check by hand or a TCGdex answer.
3. Which aggregator account, if any: JustTCG (self-serve, needs card), Pokemon Price Tracker (needs Business plan), PriceCharting (needs Legendary + commercial licence email to the address on their terms page). All need the owner's credentials and payment; I created none.
4. Is a verified-sale feature (PSA 10 sold median) wanted for v1 at all? If yes, only options 3 and 4 above come close, both with unresolved licence terms. Otherwise ship Phase B only.
5. eBay: does the owner have an eBay Partner Network / partner contact who can request Marketplace Insights? Otherwise drop it.
6. Scrydex, Pokedata, Collectr were not evaluated (Scrydex pricing page is JavaScript-rendered; the others not checked). Want a follow-up?

## Decisions I made that you may want to reverse

- `QuoteType` gained `'avg'` beyond the brief's list.
- Cardmarket `trend` and every TCGplayer field (including `market`) are `listing-estimate`; only `avg`/`avg1`/`avg7`/`avg30` are `provider-sale-average`. TCGplayer says Market Price is "based upon actual recent sales", but we cannot audit it, so it is not labelled a sale average.
- Cardmarket foil/non-foil quotes use variants `cardmarket-foil` / `cardmarket-nonfoil` because Cardmarket cannot say holo vs reverse.
- 0 values are dropped by the normaliser.

## Gates

See the end of this file for the final results.

Results (2026-11-08): npm run typecheck OK (core, schemas, mobile); catalog-builder tsc --noEmit OK (covers pricing-probe.ts); npm run lint 0 errors, 23 pre-existing warnings, none in pricing files; npm test --workspace=@flashydex/core 39 files / 439 tests passed (25 new). Modified files under apps/mobile and packages/core/src/{domain,services,index.ts} in git status belong to the other agent, not this task.
