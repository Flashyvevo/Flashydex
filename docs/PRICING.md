# Pricing: derived FX valuation (Phase A)

EUR-only cards (a Cardmarket price, no TCGplayer price for the exact print) get a USD estimate from a cached ECB reference rate.

## What is stored, what is derived
- Stored, unchanged: `catalog_latest_prices` (tcgplayer/USD, cardmarket/EUR) and user `price_snapshots`. No catalog schema change, no user-DB migration, no converted quote is ever inserted as an observation.
- Derived at read time in `packages/core/src/domain/valuation.ts` (`resolveUsd`, `valuationsFor`) using `packages/core/src/domain/fx.ts`.

## FX record
`{ base:'EUR', quote:'USD', rate:'1.1165', rateDate:'2026-11-06', provider:'frankfurter', fetchedAt }`
- Source: `https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD` (ECB reference rates, published on weekdays). Real response: `{"amount":1.0,"base":"EUR","date":"2026-11-06","rates":{"USD":1.1165}}`.
- Cache: app storage, `localStorage['fdx.fx.EURUSD']` = `{ v:1, record }` (`apps/mobile/src/lib/fx/store.ts`). Not in the SQLite DB. Unknown version/corrupt/invalid = no record.
- Refresh (`data/fx-hooks.ts`): on start and when connectivity returns, if there is no record or `rateDate` is older than 1 day, and at most once per 6 h (weekend rates stay Friday's). Offline/HTTP/parse failure keeps the last verified record. A record dated >1 day in the future is rejected.
- Core receives it through `ServiceContext.fx?: { get('EUR','USD') }` (sync snapshot; `createServices({ fx })`). Core never fetches and has no default rate: no record means USD is unavailable.
- Stale = `rateDate` more than 7 days before the context clock. A stale rate is still used and flagged (`stale: true`, UI "FX rate from <date>").
- Changing the record invalidates every `['fd']` query, so dashboard/card/list values recompute.

## Money math
Integer cents only. The rate string is parsed to a BigInt scaled by 10^6 (more digits round half-up; <=0, >1000 or non-decimal text rejected). `convertCents(c, rate) = floor((c*rate6 + 500000) / 10^6)` in BigInt: half-up to the cent, deterministic, no floats. Results above `MAX_CENTS` (2^31-1) throw `RangeError` (valuation treats that as unavailable).

## USD price selection (exact variant + variantDetail only)
1. Manual price wins (never converted).
2. Graded copy: no automatic value.
3. TCGplayer `market`, else `mid` (native; unchanged).
4. Else Cardmarket `mid` (EUR) x FX -> USD, `source:'cardmarket'`, `converted:true`, plus `originalCents`, `originalCurrency:'EUR'`, `fxRate`, `fxRateDate`, `fxProvider`, `quoteType:'avg'`, `stale`.
5. Else (Cardmarket price exists but no usable FX): no USD value, counted as `fxUnavailableCopies`.
A variant never inherits another variant's price; a converted Cardmarket quote is never labelled TCGplayer or a US sale; one copy contributes exactly one USD value.

EUR display is unchanged (Cardmarket mid). Converting USD-only cards to EUR is NOT part of Phase A.

## Portfolio
USD `CurrencyStats` include converted copies in `valuedCopies`/`estimatedValueCents`/`pricedCopies`, and add `sourcePricedCopies` (native or manual), `convertedCopies`, `convertedValueCents`, `staleFxCopies`, `fxUnavailableCopies`, `costConvertedCopies`, `fxRateDate`. Gain/loss: an EUR cost vs a USD value is comparable only by converting the cost with the same FX record (one rounding per cost-currency group); without FX it is not comparable. Total paid is never converted.

## UI strings
- Dashboard: `N source-priced · N converted (FX <date>) · N unpriced`; stale: `FX rate from <date>`; unavailable: `N copy has/copies have only a Cardmarket price — USD value unavailable (no exchange rate yet)`.
- Card details: `Estimated value $X` and `Cardmarket €21.40 → $23.89 · ECB rate 1.1165 (2026-11-06)` / `TCGplayer market $X`; unavailable: `USD value unavailable — no exchange rate yet · Cardmarket avg €X`.
