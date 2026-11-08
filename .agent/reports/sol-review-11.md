# sol-review-11 — Pricing V2 Phase A

Verdict: release Phase A to production: yes-after-P1s.

Do not ship reviewed HEAD until R11-01, R11-02 and R11-03 are fixed and re-tested. Existing gates pass; adversarial probes expose acceptance failures they do not cover. No P0 found.

Reviewed branch: `pricing-v2` (verified before and after execution).
Reviewed HEAD: `a2a40c01e1dda5096b519148349760595adbd236`.
Baseline/range: `dc9d7ea` / `git diff dc9d7ea..HEAD`.
Read both child reports, owner rules, requested documentation, implementation, schemas diff and pricing tests. No production deployment or native-device validation performed.

## Findings

| id | severity | file:line | what | why | fix |
|---|---|---|---|---|---|
| R11-01 | P1 | packages/core/src/domain/fx.ts:36-56 | Accepted 7–12-digit rates are rounded to six digits BEFORE cents multiplication, causing double-rounding and incorrect overflow decisions. | Exact-decimal oracle disagrees, including ordinary rate `1.11650049`; see table. `MAX_CENTS × 1.0000004` should overflow but is accepted. Quantization is documented, but fails this review's explicit exact-decimal acceptance criterion. Existing property test generates only three fractional digits. | Retain full accepted decimal numerator/denominator in BigInt and round final cents once; preserve six-digit fast path if desired. Add long-rate, tie and overflow regressions. Do not silently accept a different rate from the provenance string. |
| R11-02 | P1 | apps/mobile/src/routes/_tabs/index.tsx:18,198-204 | Dashboard labels primary USD total `TCGplayer prices`, even for an entirely Cardmarket-converted portfolio. With EUR primary, secondary converted USD total is also labelled `from TCGplayer prices`. | Violates owner's hard rule against labelling converted Cardmarket values as TCGplayer. New coverage line does not make contradictory source label true. Proven by unconditional render expressions; existing E2E does not assert these labels. | Derive attribution from actual coverage; use mixed/native/Cardmarket-converted/manual wording for BOTH totals. Add all-converted and mixed-source assertions. |
| R11-03 | P1 | packages/core/src/domain/fx.ts:79-82; apps/mobile/src/lib/fx/store.ts:15-18,58-64,81-88 | Persisted records are incompletely validated: numeric/array rates, impossible dates and future dates/timestamps are accepted. | Probes accepted every malformed case below. Cached rateDate `2099-01-01` suppresses refresh and refuses replacement by a valid current record. Corrupted cache can remain a trusted, non-stale valuation indefinitely. HTTP future-date rejection is not applied to cache reads. | Validate unknown input with strict string/provider/instant checks, calendar-date round-trip, and clock-relative future bounds at storage boundary. Reject malformed records as absent and permit recovery; share validation with fetched records. |
| R11-04 | P2 | apps/mobile/src/data/fx-hooks.ts:20-25; apps/mobile/src/lib/fx/store.ts:81-88 | Six-hour throttle applies only to successful cached fetches, not attempts/failures. | Three consecutive failed refresh calls made three requests; inflight only coalesces concurrent calls. Reconnects/restarts can repeatedly hit Frankfurter despite documented “at most once per 6 h”. | Track last-attempt/backoff separately from last verified record; retain cached values and test failure/reconnect throttling. |
| R11-05 | P2 | packages/core/src/pricing/tcgdex-normalise.ts:34-43; docs/PRICING-SOURCES.md:71 | TCGplayer market is classified listing-estimate despite provider explicitly describing averaging recent transactions. | “Not independently audited” is already allowed for provider-sale-average; it is not a reason to call sales-derived data a listing. Dormant Phase B/C artefact, not Phase A runtime blocker. | Classify market as provider-sale-average with unspecified window/provider methodology; keep low/mid/high/directLow listing-based. Never call market an individual verified sale. Update tests/docs. |
| R11-06 | P2 | packages/core/src/pricing/sold-summary.ts:54-88,96-103 | Sold summary validates kind/windowDays, but not valid now, finite non-negative integer cents, or homogeneous card/print identity. | Probes returned n=1 for invalid now, mean=-100 for negative cents, mean=NaN for NaN cents, and one mean=5050 across different card ids. SoldRecord number fields do not exclude these inputs. Dormant code today. | Validate clock/money at runtime; reject mixed identities or include exact identity in bucket/output contract. Preserve existing kind/date/bundle/currency/grade guards. |
| R11-07 | P2 | apps/mobile/src/components/card-details.tsx:265,422; apps/mobile/src/components/owned.tsx:107-124 | Detailed FX provenance is hidden above 50 copies of a card: allLoaded is false on every paginated page. Unowned cards also never get new estimate block. | Converted copy rows only say `(converted)`; tiles show number without FX metadata. Large holdings cannot see original EUR/rate/date on card screen. Child disclosed only unowned-card limitation. | Render per-print provenance from loaded copies without implying complete aggregate, or expose it per converted copy; gate aggregate totals separately. Add >50-copy coverage. |

## Adversarial conversion table

Outputs are integer USD cents, not dollars. Independent oracle parses full decimal to integer fraction and computes `floor((2*c*n+d)/(2*d))`, then applies MAX_CENTS. It does not reuse parseRateScaled. RangeError means rounded output exceeds 2147483647.

| EUR cents | rate string | actual rate6 | exact decimal result | implementation result | match |
|---:|---|---:|---:|---:|---|
| 2140 | 1.1165 | 1116500 | 2389 | 2389 | yes |
| 1 | 0.499999 | 499999 | 0 | 0 | yes |
| 1 | 0.5 | 500000 | 1 | 1 | yes |
| 1 | 0.500001 | 500001 | 1 | 1 | yes |
| 100 | 0.005 | 5000 | 1 | 1 | yes |
| 99 | 0.005 | 5000 | 0 | 0 | yes |
| 101 | 0.005 | 5000 | 1 | 1 | yes |
| 1 | 0.4999995 | 500000 | 0 | 1 | NO |
| 1000000 | 1.0000004 | 1000000 | 1000000 | 1000000 | yes |
| 1000000 | 1.0000005 | 1000001 | 1000001 | 1000001 | yes |
| 2147483647 | 1 | 1000000 | 2147483647 | 2147483647 | yes |
| 2147483647 | 0.999999 | 999999 | 2147481500 | 2147481500 | yes |
| 2147483647 | 0.9999999 | 1000000 | 2147483432 | 2147483647 | NO |
| 2147483647 | 1.000000000001 | 1000000 | 2147483647 | 2147483647 | yes |
| 2147483647 | 1.0000004 | 1000000 | RangeError | 2147483647 | NO |
| 1000001 | 1.11650049 | 1116500 | 1116502 | 1116501 | NO |
| 2147483647 | 1.000001 | 1000001 | RangeError | RangeError | yes |
| 2147483647 | 0.0000005 | 1 | 1074 | 2147 | NO |

Seeded diagnostic output, verbatim:
```text
DECIMAL_ORACLE {"n":10000,"mismatch6":0,"mismatch12":9963}
```
Generated populations use six- and twelve-place rates respectively; this is not a claim about actual ECB rate distribution. For <=6 digits the BigInt half-up formula is correct. Current Frankfurter fixture's four-digit rate is correct. Long accepted rates are the failure.

Fallback audit: source searches for literal example rates, DEFAULT_RATE/FALLBACK_RATE and FX usages found examples in comments/tests, not executable default rates. resolveFx(undefined,now) returned null; missing/invalid FX left EUR-only copies without USD valuations in service tests/E2E. No literal fallback rate found.

## Selection and aggregation

- Exact variant/detail: ad hoc services supplied only normal and unlimited prices; reverse_holo and first_edition stayed unvalued. No cross-variant rescue.
- EN/JA: separate catalog identity keys; same card id produced original EUR cents 2140 vs 100. loadQuotes binds language and maps by (language,id), context.ts:103,125-148.
- Graded copies did not inherit raw value; manual USD/EUR replaced all automatic valuations. Manual is checked before graded (valuation.ts:92-96), so overrides also win on graded copies.
- Native USD 500 won over Cardmarket EUR 400 for a copy with both. Converted DTOs retained source=cardmarket, quoteType=avg, original amount and FX metadata; no fake sale/converted observation stored. Original EUR rows remain exposed and unchanged (passing existing service test).
- Each copy contributed one value per currency. Independent mixed-inventory probe compared dashboard with hydrated per-copy USD sums at each FX state; no EUR cents added to USD and no TCGplayer+Cardmarket double addition.
- Missing values stay null/absent, not inferred zero. Existing all-unpriced and missing-price tests passed. Empty USD stats deliberately omit optional FX fields; interpret omitted counts as zero.

Coverage probe (24 copies, including native, converted, missing print, graded, manual USD/EUR):

| FX state | source | converted | stale subset | unpriced | FX-unavailable subset | USD total cents | disjoint partition |
|---|---:|---:|---:|---:|---:|---:|---|
| missing | 6 | 0 | 0 | 18 | 6 | 3831 | [6,0,0,12,6] |
| fresh | 6 | 6 | 0 | 12 | 0 | 11334 | [6,6,0,12,0] |
| stale | 6 | 6 | 6 | 12 | 0 | 11334 | [6,0,6,12,0] |
| invalid rate | 6 | 0 | 0 | 18 | 6 | 3831 | [6,0,0,12,6] |

The five raw counters are NOT disjoint. staleFxCopies is inside convertedCopies; fxUnavailableCopies is inside unvaluedCopies. Adding all five gave 30, not 24, for missing/stale/invalid states. This is nested accounting, not duplicated valuation.
Verified partition: `source + (converted-stale) + stale + (unvalued-fxUnavailable) + fxUnavailable == totalCopies`, all terms non-negative. UI three-way source+converted+unpriced also partitions exactly. Document this explicitly; do not present five raw counters as additive categories.

Cost/gain-loss: coherent as implemented in portfolio.ts:82-100 and docs/PRICING.md:31-32. Paid totals stay in recorded currency. USD comparability includes EUR cost only after conversion with same FX snapshot; costConvertedCopies flags it. Without FX, EUR cost against native USD is excluded. Existing tests verified comparable cost 2333, comparable value 2639, gain/loss 306 and totalPaid USD 100; EUR paid remains separate.
Cost conversion rounds once per aggregate group, not per purchase; this is disclosed. Regrouping can change a cent, and summed converted cost above per-amount MAX_CENTS is excluded. DATA-MODEL.md:539's older SAME-currency-only wording should be read with explicit Phase A extension at :540, not as unchanged policy.

## FX lifecycle and UI provenance

- Key/version: fdx.fx.EURUSD, envelope {v:1,record}; no SQLite migration. Unknown version, malformed JSON, absent key and storage exceptions return null in passing unit tests. Semantic validation is incomplete (R11-03).
- Offline/fetch failure: cached record/date retained, >7-day stale flag shown, no-cache state unavailable rather than $0.00. Pricing E2E passed these paths. Test simulates fetch disconnection, not disabling the whole browser network.
- Frankfurter HTTP errors, thrown network errors, HTML and incomplete JSON are ignored by passing parser/fetch tests; no rate substitution. HTTP date 2026-02-31 was accepted in the ad hoc probe: actual calendar validation is missing too.
- Success-cache throttle: <=1-day reference needs no refresh; older reference refreshes after >=6 h since fetchedAt. Failed attempts lack backoff (R11-04). Refresh is event-driven on mount/connectivity, not periodic.
- Record changes re-run dashboard/card/list queries through useFxSync's date:rate stamp and invalidateAll(['fd']). Ad hoc React test observed invalidation calls 1→2→3 for initial state, new record, and same-date changed rate. Real hook/store, invalidation spied; keys.ts:39-40 confirms actual query prefix.
- Card text is honest on covered paths: `Cardmarket €2.25 → $2.51 · ECB rate 1.1165 (<date>)`, native `TCGplayer market ...`, unavailable `USD value unavailable — no exchange rate yet · Cardmarket avg €2.25`. Original EUR/ECB date present, no sale claim. R11-02/R11-07 cover remaining provenance gaps.
- Overflow maps to fx_unavailable too, so “no exchange rate yet” can be inaccurate with a valid rate but unsupported amount (valuation.ts:86-87; coverage.ts:23). Prefer neutral “conversion unavailable” or separate reason in follow-up.

Malformed-cache probe output, verbatim:
```text
CACHE {"name":"numberRate","accepted":true,"needsRefresh":false,"coreValid":true}
CACHE {"name":"arrayRate","accepted":true,"needsRefresh":false,"coreValid":true}
CACHE {"name":"badCalendar","accepted":true,"needsRefresh":false,"coreValid":true}
CACHE {"name":"futureRate","accepted":true,"needsRefresh":false,"coreValid":true}
CACHE {"name":"futureFetched","accepted":true,"needsRefresh":false,"coreValid":true}
CACHE {"name":"badFetched","accepted":true,"needsRefresh":true,"coreValid":true}
FUTURE_CACHE_REPLACEMENT {"replacementAccepted":false,"date":"2099-01-01"}
FAILED_FETCH_ATTEMPTS 3
QUERY_INVALIDATION {"before":1,"first":2,"second":3}
```

## Phase B/C artefacts

avg7/avg30 (+foil twins) map to provider-sale-average; low/trend remain listing estimates; zero/null dropped; unexpected currency blocks dropped; Cardmarket foil buckets do not guess holo vs reverse. Pure, unwired artefacts. Cardmarket completed-sales interpretation remains qualified as primary-source-unverified in docs/PRICING-SOURCES.md:69.

TCGplayer's own definition contradicts child's market classification:
“TCGplayer Market Price shows you the value of a collectible based upon actual recent sales”.
“We take the prices at which a collectible has been selling, average across multiple recent transactions, and use that information to show you the most reliable market value of that product.”
Source: https://help.tcgplayer.com/hc/en-us/articles/213588017-TCGplayer-Market-Price
Retrieved from primary-page search-index excerpts during review; direct browser access hit Cloudflare verification. Supports provider-sale-average, not listing-estimate and not verified-sale. No invented lookback window or transaction-level verification warranted.

summariseSold's kind guard rejects listings; window is (now-days,now]; invalid/future soldAt and bundles excluded; raw/grade/company/currency buckets separate; IQR/MAD and exclusion totals tested. MAD=0 deliberately retains everything, including extremes. R11-06 covers missing guards. Diagnostic output, verbatim:
```text
SOLD_GAPS {"invalidNowN":1,"negativeMean":-100,"nanMean":"NaN","mixedIdentityMean":5050}
```

## Regression and gate results

`git diff --stat dc9d7ea..HEAD` summary, verbatim:
```text
 46 files changed, 2314 insertions(+), 24 deletions(-)
```
No diff under apps/mobile/src/platform/**, packages/core/src/platform/**, packages/core/src/db/**, frozen scanner/recognition paths, netlify/** or TOP-LEVEL services/**. Core pricing service files changed intentionally. Under tools/catalog-builder/**, only src/pricing-probe.ts added; no build pipeline/catalog-normalisation changes. No pack rebuild/publish. Manifest/trusted-origin configuration unchanged; only reference-line difference is catalog: catalogConfig() acquiring a trailing comma for FX option. Existing untracked dev packs not modified.
Built JS contains exact public Frankfurter URL and fetch options {signal:...,headers:{accept:"application/json"}}. Inspection found no Frankfurter key/token/Authorization/credential fields in request. No credentials exist for this integration. Production manifest/packs are not referenced differently.

Gate excerpts below are verbatim from this review's executions, not child reports.

`npm run typecheck`:
```text
> flashydex@0.0.0 typecheck
> npm run typecheck --workspace=@flashydex/core && npm run typecheck --workspace=@flashydex/schemas && npm run typecheck --workspace=@flashydex/mobile


> @flashydex/core@0.0.0 typecheck
> tsc --noEmit -p tsconfig.json


> @flashydex/schemas@0.0.0 typecheck
> tsc --noEmit -p tsconfig.json


> @flashydex/mobile@0.0.0 typecheck
> tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.node.json


TYPECHECK_EXIT=0
```
`npm run lint` (existing react-refresh/unused-directive warnings):
```text
✖ 23 problems (0 errors, 23 warnings)
  0 errors and 1 warning potentially fixable with the `--fix` option.


LINT_EXIT=0
```
`npm run test --workspace=@flashydex/core`:
```text
 Test Files  39 passed (39)
      Tests  439 passed (439)
   Start at  15:18:07
   Duration  47.31s (tests 77%, import 22%, worker 1%, transform 1%)
```
```text
CORE_UNIT_EXIT=0
```
`npm run test --workspace=@flashydex/mobile`:
```text
 Test Files  39 passed (39)
      Tests  487 passed (487)
   Start at  15:18:56
   Duration  47.13s (tests 39%, environment 32%, import 17%, setup 10%, transform 1%)
```
```text
MOBILE_UNIT_EXIT=0
```
`cd apps/mobile && FLASHYDEX_E2E_PORT=3217 npx playwright test e2e/pricing.spec.ts e2e/core-flow.spec.ts e2e/routes.spec.ts e2e/scanner.spec.ts --project=mobile --workers=1`:
```text
Running 16 tests using 1 worker
```
```text
  16 passed (2.9m)

E2E_EXIT=0
```
All requested specs ran with fresh Playwright contexts and managed test-only :3217. No use of owner's browser profiles, :3200 server, recognizer PID 12676 or :8900.

`npm run build --workspace=@flashydex/mobile` excerpts:
```text
✓ 2645 modules transformed.
```
```text
✓ built in 11.91s
```
```text
PWA v2.0.0
mode      injectManifest
format:   es
precache  90 entries (6499.13 KiB)
files generated
  dist/sw.js

MOBILE_BUILD_EXIT=0
```
Build also reported Zod annotation, static/dynamic import and >500kB chunk warnings; no failure.

Temporary diagnostic suite (allowed packages/core/test/__sol_tmp__review11.test.ts; deleted):
`npm run test --workspace=@flashydex/core -- test/__sol_tmp__review11.test.ts --reporter=verbose`
```text
 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  15:28:10
   Duration  3.79s (environment 52%, import 25%, tests 14%, transform 8%)
```
Diagnostic tests assert observed behaviour INCLUDING defects; green status is not release acceptance. Inline Node probe was approval-blocked; no result assumed. Allowed Vitest file supplied actual evidence.

Additional hygiene check git diff --check dc9d7ea..HEAD: exit 2, CRLF/trailing whitespace on added lines in data/index.ts, collection-list.ts and services/index.ts. Lint exits 0; not a release blocker.
Before report creation, tracked working tree unchanged; temporary test removal verified. Only durable authored review file is this report. No fixes, commits, owner-service changes or catalog-pack writes; test databases were synthetic.
