# sonnet-fx-fix report

Status: GREEN. Branch pricing-v2 (verified). Nothing committed, no installs, no pushes. Frozen files (scanner, src/platform/**, packages/core/src/db/**, catalog-builder) untouched. e2e ran on its own port 3219 with fresh Playwright profiles.

Red evidence, stated honestly: I did not re-run the new tests against the old code. For R11-01 the red is Sol's adversarial table (5 NO rows: 0.4999995, 0.9999999, 1.0000004, 1.11650049, 0.0000005); all are pinned as tests and now green. The other items were red by construction (new assertions for behaviour that did not exist). The one red I observed in this session: after the strict validator landed, 11 core tests failed because their fixtures (rateDate 2026-11-06, fetchedAt 2026-10-30T11:00) were in the future of the test clock (2026-10-30); I corrected the fixtures to 2026-10-29, no production check was loosened.

## R11-01 exact decimal conversion (P1)
- packages/core/src/domain/fx.ts:43 parseRateExact -> (unscaled BigInt, scale) at full precision; <= 12 fractional digits; 0 < rate < 1000. parseRateScaled and the 6-digit quantisation are removed.
- fx.ts:68 convertCents: product = cents x unscaled; out = product / 10^scale; +1 when 2 x remainder >= 10^scale (half-up on the exact remainder); overflow checked on that exact result against MAX_CENTS.
- Tests packages/core/test/fx.test.ts: Sol's full 18-row table (1.11650049 -> 1116502, MAX_CENTS x 1.0000004 -> RangeError, 0.005 boundaries, rate "1", "0.999999", 12-digit 1.000000000001), plus a 3000-case seeded property test of 1-12 digit rates against an independent digit-string BigInt oracle floor((2cn + d) / 2d) (no floats, no shared code with fx.ts).
- One of my own table rows was wrong at first (1.000000000001 does not overflow; Sol's table says 2147483647); corrected.

## R11-03 strict validation on read and fetch (P1)
- fx.ts:102 validateFxRecord(unknown, now): rate string regex + range; rateDate real calendar date (round-trip), >= 1999-01-04, <= now + 1 day; fetchedAt ISO instant (calendar and h/m/s checked), not in the future (5 min skew); provider/base/quote literals. Returns a clean copy. isValidFxRecord(record, now) and resolveFx use it, so core also rejects bad records.
- apps/mobile/src/lib/fx/store.ts:24 readStoredFx validates; corrupt JSON / invalid / future record -> null AND the key is deleted (unknown version is left alone). store.ts:125 FxStore.set: a held record that is invalid or future vs the clock never blocks a valid new one.
- apps/mobile/src/lib/fx/frankfurter.ts uses the same validator (2026-02-31, pre-1999 dates, >12-digit rates rejected on fetch).
- Tests: fx.test.ts (26 malformed cases incl. every Sol case: numeric/array rate, bad calendar, future rateDate/fetchedAt, bad fetchedAt), store.test.ts (each malformed cache read -> null and deleted; future-cache replacement), frankfurter.test.ts.

## R11-04 attempt throttle (P2)
- store.ts: key 'fdx.fx.EURUSD.attempt', readLastAttempt/writeLastAttempt, FxStore.lastAttemptAt()/markAttempt(); fxNeedsRefresh(record, now, lastAttempt) is false within 6 h of any attempt (store.ts:151). A future-dated stamp is discarded.
- apps/mobile/src/data/fx-hooks.ts:25 refreshFxIfNeeded stamps the attempt before fetching; inflight coalescing kept; injectable deps for tests.
- Tests src/data/fx-hooks.test.ts: three failing refreshes -> 1 fetch call; survives a store restart; allowed again after 6 h; HTTP 503 counts as an attempt; concurrent callers coalesce. Consequence of the literal "regardless of outcome": an offline first launch with no cache waits 6 h for the next attempt.

## R11-02 dashboard source label (P1)
- apps/mobile/src/lib/fx/coverage.ts:53 describeValueSource(stats, currency): all source -> "TCGplayer prices"; all converted -> "Cardmarket prices converted to USD (ECB <date>)"; mixed -> "TCGplayer + converted Cardmarket prices"; EUR -> "Cardmarket prices".
- apps/mobile/src/routes/_tabs/index.tsx:203 primary source line (testid value-source) and :199 secondary total line use it; the hardcoded SOURCE map is gone.
- Tests: coverage.test.ts unit; e2e/pricing.spec.ts mixed and all-converted assertions. Caveat: sourcePricedCopies also counts manual-priced copies (existing core semantics), so an all-manual USD portfolio would read "TCGplayer prices"; not changed.

## R11-07 card details provenance (P2)
- apps/mobile/src/components/card-details.tsx:111 printsFromCopies (from whatever copies are loaded, no allLoaded gate), :102 printsFromQuotes (unowned: core valuationsFor over latestPrices with the live FX context, per exact print), :289 estimateNote: "Showing prices for the first N of M copies." (page 0) / "Showing prices for the N copies on this page (of M)." / "You don’t own this card yet — estimate from the latest prices." The aggregate "Your copies are worth..." line stays gated on allLoaded.
- e2e: unowned swsh3-105 shows the converted $2.51 line + ECB provenance; 55 copies shows provenance and "Showing prices for the first N of 55 copies."
- Not changed: owned tiles still show a bare number; copy rows still say "(converted)".

## R11-05 TCGplayer market (P2)
- packages/core/src/pricing/types.ts: MarketQuote.methodology?: 'provider-unspecified'. tcgdex-normalise.ts:34-84: market -> provider-sale-average + methodology; low/mid/high/directLow stay listing-estimate; Cardmarket unchanged (no methodology key). docs/PRICING-SOURCES.md lines 71 and 127 updated. Tests updated and extended.

## R11-06 sold summary guards (P2)
- packages/core/src/pricing/sold-summary.ts:67-90: invalid/non-Date now -> RangeError; priceCents must be a finite non-negative integer -> RangeError; mixed (language, cardId, variant, variantDetail) -> TypeError; existing kind/window/bundle/grade guards intact. Tests for each in pricing-sold-summary.test.ts.

## Docs
docs/PRICING.md: exact-decimal rounding, strict validation + attempt throttle, source-label rule, and Sol's nested-counter partition (staleFxCopies inside convertedCopies, fxUnavailableCopies inside unvaluedCopies).

## Not done
- fx_unavailable also covering overflow ("no exchange rate yet" wording): out of scope.
- Owned tile / copy-row FX metadata (second half of R11-07).
- Sol's CRLF whitespace hygiene note.

## Gates (verbatim)
npm run typecheck: 0 `error TS` lines (core, schemas, mobile).
npm run lint:
  ✖ 23 problems (0 errors, 23 warnings)
core unit:
  Test Files  39 passed (39)
       Tests  449 passed (449)
mobile unit:
  Test Files  40 passed (40)
       Tests  498 passed (498)
e2e (FLASHYDEX_E2E_PORT=3219 --project=mobile --workers=1; pricing + core-flow + routes):
  9 passed (1.5m)
  E2E_EXIT=0
  (first attempt: 8 passed, 1 failed - my own unowned-card assertion used .first() on a multi-print card; fixed the test, not the product)
build (npm run build --workspace=@flashydex/mobile):
  ✓ built in 12.06s
  precache  90 entries (6501.92 KiB)
  BUILD_EXIT=0
Logs: .agent/reports/fx-fix-e2e.log, .agent/reports/fx-fix-build.log
