# sonnet-fx-fix — close Sol review 11 (R11-01..03 P1; R11-04, R11-07 P2; R11-05/06 pricing-module P2)

Unattended; never ask questions; no screenshots/images; report draft FIRST. Repo `C:/Projects/flashydex`, branch `pricing-v2` (verify; STOP if not). No commits, no `npm install`, no pushes. Read `.agent/reports/sol-review-11.md` in full (findings + adversarial table) and your predecessor's `.agent/reports/sonnet-fx-valuation-report.md`. Same ownership as `.agent/sonnet-fx-valuation-task.md` PLUS `packages/core/src/pricing/**` (Sol's R11-05/06). Frozen files unchanged (scanner, `src/platform/**`, `packages/core/src/db/**`, builder).

## Items
1. **R11-01 (P1)** `packages/core/src/domain/fx.ts`: exact decimal arithmetic — parse the rate string into (unscaledBigInt, scale) with its FULL precision (accept ≤ 12 fractional digits), compute `cents × unscaled`, divide by 10^scale with round-half-up on the exact remainder, overflow check on the exact result against MAX_CENTS. Add Sol's adversarial cases as tests (rate `1.11650049`, `MAX_CENTS × 1.0000004` must overflow/reject, 0.005 boundaries, rate "1", "0.999999", 12-digit rates) against a string-based exact oracle in the test (no floats).
2. **R11-02 (P1)** dashboard `_tabs/index.tsx`: source label must be derived from the bucket composition: all source-priced → "TCGplayer prices"; all converted → "Cardmarket prices converted to USD (ECB <date>)"; mixed → "TCGplayer + converted Cardmarket prices"; EUR primary → "Cardmarket prices"; the secondary total line likewise. e2e assertion for the all-converted and mixed cases.
3. **R11-03 (P1)** `fx.ts` `isFxRecord`/store: strict validation on READ as well as fetch — rate must be a decimal string matching `^\d+(\.\d{1,12})?$` in (0, 1000); `rateDate` a real calendar date (YYYY-MM-DD, valid month/day) not in the future (vs now, +1 day tolerance for timezones) and not before 1999-01-04 (euro birth); `fetchedAt` valid ISO not in the future; provider literal. Invalid cached record → treated as absent AND deleted/overwritten. A valid new record always replaces a cached one whose rateDate is newer-than-now. Tests for each malformed case Sol listed.
4. **R11-04 (P2)** throttle attempts, not just successes: persist `lastAttemptAt` (separate key), minimum 6 h between attempts regardless of outcome, with the inflight coalescing kept; tests: three failing refreshes → one network call.
5. **R11-07 (P2)** card details: compute provenance from the loaded copies per print (don't require allLoaded); when > pageSize copies, show provenance from the first page and say "showing first N"; unowned cards: show the estimate block from quotes (USD native or converted) so the card screen is informative before you own it.
6. **R11-05 (P2)** `tcgdex-normalise.ts`: classify TCGplayer `market` as `provider-sale-average` with `methodology:'provider-unspecified'` (add that optional field); low/mid/high/directLow stay listing-estimate; update docs/PRICING-SOURCES.md line + tests.
7. **R11-06 (P2)** `sold-summary.ts`: validate `now` finite, cents finite non-negative integers, homogeneous identity (language, cardId, variant, variantDetail) — throw on mixed; tests for each.

## Gates
`npm run typecheck`, `npm run lint` (0 errors), core + mobile unit, `e2e/pricing.spec.ts` (`FLASHYDEX_E2E_PORT=3219`), `e2e/core-flow.spec.ts`, `e2e/routes.spec.ts`, `npm run build --workspace=@flashydex/mobile`. Touch `.agent/pricing-ready-fix` when green.

## Report
`.agent/reports/sonnet-fx-fix-report.md`: per item file:line, red→green, gate output verbatim.
