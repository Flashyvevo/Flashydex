# sonnet-fx-valuation report

Status: GREEN. Branch pricing-v2. Nothing committed, no installs, no pushes. Dev server :3200 untouched (e2e used its own Vite on :3215, fresh Playwright profiles).

## Files
Core
- NEW packages/core/src/domain/fx.ts (FxRecord, FxProvider, parseRateScaled, convertCents/tryConvertCents, isFxStale, isValidFxRecord, resolveFx)
- packages/core/src/domain/valuation.ts (resolveUsd, valuationsFor(copy, quotes, fx?), quoteType on native/EUR valuations)
- packages/core/src/services/portfolio.ts, owned-read.ts, collection-list.ts (pass fx; collection-list not in the ownership list but it calls valuationsFor, so priced filter/value sort needed it)
- packages/core/src/services/context.ts (ServiceContext.fx?, fxFor), services/index.ts (CreateServicesOptions.fx, one line; not in ownership list, needed to pass the provider), src/index.ts (export fx)
- packages/schemas/src/entities.ts (additive optional fields on ValuationDto + CurrencyStats)
- NEW tests: packages/core/test/fx.test.ts, valuation-fx.test.ts, portfolio-fx.test.ts
App
- NEW apps/mobile/src/lib/fx/{frankfurter,store,coverage}.ts + .test.ts each; NEW src/data/fx-hooks.ts; src/data/index.ts (exports), bootstrap.ts (pass fx), provider.tsx (mounts FxSync). bootstrap.ts/provider.tsx are not in the ownership list; needed for wiring.
- routes/_tabs/index.tsx (dashboard FX lines), components/card-details.tsx (EstimatedValue block, "(converted)" on copy rows), components/owned.tsx (type only; owned tiles pick up the USD value automatically through valuationFor)
- NEW apps/mobile/e2e/pricing.spec.ts
Docs: NEW docs/PRICING.md; docs/DATA-MODEL.md (one additive bullet in "Definitions for every screen and aggregate").
lib/price-gap.ts: unchanged (still reports "No USD price €X" in the Prices table; the new Estimated value block sits below it).

## Real Frankfurter response (curl, 2026-11-08)
GET https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD
{"amount":1.0,"base":"EUR","date":"2026-11-06","rates":{"USD":1.1165}}
rateDate is the last ECB publishing day (Friday on a Sunday). The rate is a JSON number, stored as the decimal string "1.1165". The parser test uses this body verbatim.

## Selection rules as implemented (USD, exact variant+variantDetail)
1 manual (never converted) > 2 graded: none > 3 tcgplayer market else mid > 4 cardmarket mid x FX (source 'cardmarket', converted:true, originalCents, originalCurrency, fxRate, fxRateDate, fxProvider, quoteType 'avg', stale) > 5 cardmarket price but no usable FX: no USD value, counted fxUnavailableCopies.
EUR display unchanged (cardmarket mid), no USD->EUR conversion (documented). Manual EUR price: no USD value is derived (manual wins and replaces all automatic valuations).
Cost vs value: EUR cost against USD value converts the cost with the same FX record (one rounding per cost-currency aggregate group), flagged by costConvertedCopies, excluded from totalPaid. Without FX it is not comparable.

## Rounding proof
convertCents = floor((cents * rate6 + 500000) / 1e6) in BigInt, rate6 = rate parsed to integer scaled by 1e6 (>6 digits round half-up; <=0, >1000, exponent/non-decimal rejected). That is round-half-up for non-negative integers, no floats. Tests: hand-computed 2140 x 1.1165 = 2389.31 -> 2389; exact ties 1x1.5 -> 2, 1x0.5 -> 1, 3x0.5 -> 2, 5x0.1 -> 1, 4x0.1 -> 0; seeded 2000-case property test (|out - exact| <= 0.5 cent checked in integer arithmetic, exact ties round up, monotone in cents and rate, deterministic); overflow: MAX_CENTS at rate 1 ok, MAX_CENTS x 1.000001 / x999 throw RangeError, negative/fractional/unsafe/malformed rate throw.

## Test results (real output)
- npm run typecheck: clean (core, schemas, mobile).
- npm run lint: 0 errors, 23 warnings (all pre-existing react-refresh/unused-directive kinds).
- core vitest (new three files): Test Files 3 passed (3), Tests 31 passed (31).
- core vitest full: Test Files 39 passed (39), Tests 439 passed (439).
- mobile vitest full: Test Files 39 passed (39), Tests 487 passed (487) (includes the 18 new fx tests).
- Playwright pricing.spec.ts (mobile, FLASHYDEX_E2E_PORT=3215): 4 passed (36.8s).
- Playwright core-flow + routes (mobile): 3 passed (41.5s).
- Playwright scanner.spec.ts (mobile): first run 8 passed, 1 failed (onboardAndInstall stayed on "/" for 30 s, in scanner.spec.ts:35 setup, 2 workers); rerun with --workers=1: 9 passed (1.8m). I read the first failure as parallel-worker contention (Web Locks/OPFS), not this change (scanner files untouched), but I did not run the baseline to prove it.
- npm run build --workspace=@flashydex/mobile: built, PWA precache 90 entries.

Gate mapping: (1)-(6),(8)-(11) in valuation-fx.test.ts; (7),(12),(5),(6),(11) aggregates in portfolio-fx.test.ts; EN vs JA (10) uses separate en/ja catalogs with the same card id.

## UI strings
Dashboard: `1 source-priced · 1 converted (FX 2026-11-07) · 0 unpriced`; stale `FX rate from <date>`; `N copy has / N copies have only a Cardmarket price — USD value unavailable (no exchange rate yet)`. Existing "N of M copies priced" line kept.
Card details: `Estimated value $2.51`; `Cardmarket €2.25 → $2.51 · ECB rate 1.1165 (<date>)`; native `TCGplayer market $X` (or `mid`); EUR `Cardmarket avg €X`; unavailable `USD value unavailable — no exchange rate yet · Cardmarket avg €2.25`. Copy row: `Worth $X (converted)`.

## Deviations / notes
- Cache refresh key: instead of adding rateDate to every query key, a record change invalidates all ['fd'] queries (same effect, one place).
- CurrencyStats FX fields are emitted only on the USD entry and only when the collection is non-empty, because the existing empty-dashboard test uses exact equality.
- quoteType also added to native tcgplayer ('market'|'mid') and EUR cardmarket ('avg') valuations (additive; no existing test broke).
- Refetch throttle: at most every 6 h even when the rate date is >1 day old, since ECB does not publish on weekends.
- The "no hardcoded rate" check is behavioural (no record -> null, tests 5/5b), as instructed.

## Open risks
- Card details show Estimated value only for owned copies (valuations come from OwnedDto); an un-owned catalog card still shows the old price-gap text.
- First app start offline with no cache: EUR-only cards have no USD value until the first successful fetch.
- Cost conversion rounds once per (card, variant, detail, cost-currency) aggregate group, so it can differ by a cent or two from per-copy rounding.
- Frankfurter is a third-party endpoint with no SLA; failure degrades to cached/unavailable, never a guess.
- The scanner suite flaked once under 2 workers (see above).
- Working tree also holds untracked files from other pricing work (docs/PRICING-SOURCES.md, packages/core/src/pricing/, tools/catalog-builder/src/pricing-probe.ts, dev-packs/full16|full64, pricing-* tests). They are not mine and I did not touch them.
