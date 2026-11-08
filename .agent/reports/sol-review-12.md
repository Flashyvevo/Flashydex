# sol-review-12 — Pricing V2 Phase A re-verification

Verdict (release Phase A): no.
Exact conversion and corrupt-cache recovery are fixed. All requested gates pass, and automatic-source dashboard compositions are correct. R11-02 remains partial: manual totals still make false provider claims; do not close that P1 until attribution handles manual values. No new P0/P1 root cause found.
Branch verified before/after: pricing-v2; HEAD 6edfae42cf0d6740488776b601bbd3903ec35cfb.
Reviewed git diff a2a40c0..HEAD and both requested reports. Read-only review; no product fixes, installs, commits, pushes or deployments.

## Per-finding status
| Finding | Severity | Status | Evidence / remaining work |
|---|---|---|---|
| R11-01 | P1 | fixed | Independent exact-string oracle: all 18 previous rows match; 10,000 six-place and 10,000 twelve-place rates each have zero mismatches. |
| R11-02 | P1 | partially | All-converted, mixed and EUR-primary DOM probes pass for automatic values; manual USD/EUR totals remain falsely attributed (below). |
| R11-03 | P1 | fixed | All six malformed records rejected on read, deleted, and replaced by a valid persisted record; core rejects them too. |
| R11-04 | P2 | fixed | Three sequential failures -> one request; restarted store -> still one; exactly six hours -> second request. |
| R11-05 | P2 | fixed | market -> provider-sale-average + provider-unspecified; low/mid/high/directLow remain listing-estimate; unit and independent runtime probes pass. |
| R11-06 | P2 | fixed | Invalid clock and negative/NaN/infinite/fractional cents throw RangeError; mixed language/card/variant/detail throw TypeError. |
| R11-07 | P2 | fixed | Loaded-print provenance survives pagination; unowned estimate E2E passes. Aggregate remains hidden for incomplete holdings. Separate pre-existing pagination defect below. |

## Residual R11-02 and new finding
Residual R11-02 (P1): apps/mobile/src/lib/fx/coverage.ts:53-59; packages/core/src/services/portfolio.ts:69-74. sourcePricedCopies includes manual values, not just TCGplayer, and EUR attribution is unconditional. Independent DOM probe set BOTH synthetic copies to manual 500 cents; service readback confirmed source:'manual' on every valuation. USD primary rendered "$10.00" / "TCGplayer prices"; EUR primary rendered "€10.00" / "Cardmarket prices". This is the manual-wording part of the original requested fix, not a new root cause; Sonnet disclosed only the USD case. Add manual-aware counters or neutral attribution and render regressions for both totals/currencies.

NEW R12-01 (P2, pre-existing, not introduced by this diff): apps/mobile/src/data/catalog-hooks.ts:29 omits limit (schema default 30 at packages/schemas/src/primitives.ts:36), while card-details.tsx:468-472 labels/advances pages by 50 and hides pagination at <=50. Real 55-copy probe: first page renders 30 but says "1–50 of 55"; Next returns five at offset 50. Actual service pages at offsets 0/30/50 contain 30/25/5 copies. Programmatic ID union: UI-reachable 35 of 55, skipped 20. Thus copies 31–50 cannot be reached through this card's pager; at 31–50 holdings there is no pager at all. Request limit:50 explicitly or drive paging from returned page metadata; assert complete ID coverage. git blame locates the pager in 58f5b027, before the reviewed range.

## Exact-string conversion table (integer cents)
Independent browser import of actual fx.ts; oracle parses every decimal digit to BigInt n/d, computes floor((2*c*n+d)/(2*d)), and checks MAX_CENTS. Neither oracle nor expected results uses floating-point rates or parseRateExact. RangeError means rounded result exceeds 2147483647.
| EUR cents | Rate string | Exact oracle | Actual |
|---:|---|---:|---:|
| 2140 | 1.1165 | 2389 | 2389 |
| 1 | 0.499999 | 0 | 0 |
| 1 | 0.5 | 1 | 1 |
| 1 | 0.500001 | 1 | 1 |
| 100 | 0.005 | 1 | 1 |
| 99 | 0.005 | 0 | 0 |
| 101 | 0.005 | 1 | 1 |
| 1 | 0.4999995 | 0 | 0 |
| 1000000 | 1.0000004 | 1000000 | 1000000 |
| 1000000 | 1.0000005 | 1000001 | 1000001 |
| 2147483647 | 1 | 2147483647 | 2147483647 |
| 2147483647 | 0.999999 | 2147481500 | 2147481500 |
| 2147483647 | 0.9999999 | 2147483432 | 2147483432 |
| 2147483647 | 1.000000000001 | 2147483647 | 2147483647 |
| 2147483647 | 1.0000004 | RangeError | RangeError |
| 1000001 | 1.11650049 | 1116502 | 1116502 |
| 2147483647 | 1.000001 | RangeError | RangeError |
| 2147483647 | 0.0000005 | 1074 | 1074 |
All five previously failing rows, including MAX_CENTS × 1.0000004, are corrected. Additional seeded populations: 10000 six-place / 0 mismatches; 10000 twelve-place / 0 mismatches.

## Cache read / recovery probes
Actual FxStore/readStoredFx plus core validator; synthetic in-memory Storage, fixed now 2026-11-08T12:00:00.000Z. Each case was loaded separately and then replaced/read back through the persistence boundary.
| Malformed case | Core valid | Cache absent + deleted | Valid replacement accepted + read back |
|---|---|---|---|
| numeric rate 1.1165 | false | yes | yes |
| array rate ['1.1165'] | false | yes | yes |
| impossible rateDate 2026-02-31 | false | yes | yes |
| future rateDate 2099-01-01 | false | yes | yes |
| future fetchedAt 2099-01-01T00:00:00.000Z | false | yes | yes |
| invalid fetchedAt 'yesterday' | false | yes | yes |
Every replacement persisted rate:'1.1165', rateDate:'2026-11-06'. Documented tolerances remain: rateDate <= now+1 day; fetchedAt <= now+5 minutes. No default FX rate used.

## Render-level / E2E observations
Independent isolated-browser DOM probes used real services, catalog pack and route, synthetic copies and cached FX 1.1165 dated 2026-11-07; settings mutations were read back before navigation.
| Composition / primary | Primary / source | Secondary |
|---|---|---|
| All converted / USD | $2.51 / Cardmarket prices converted to USD (ECB 2026-11-07) | €2.25 from Cardmarket prices |
| All converted / EUR | €2.25 / Cardmarket prices | $2.51 from Cardmarket prices converted to USD (ECB 2026-11-07) |
| Native + converted / USD | $2.61 / TCGplayer + converted Cardmarket prices | €2.46 from Cardmarket prices |
| Native + converted / EUR | €2.46 / Cardmarket prices | $2.61 from TCGplayer + converted Cardmarket prices |
55-copy first page: "Showing prices for the first 30 of 55 copies." Settled next page: "Showing prices for the 5 copies on this page (of 55)." Both display "Cardmarket €2.25 → $2.51 · ECB rate 1.1165 (2026-11-07)" and neither displays a complete-holdings aggregate. Copy rows still say only '(converted)', but detailed per-print provenance is now reachable on loaded pages, satisfying R11-07's alternative remedy.
Requested pricing E2E also verifies unowned-card conversion/provenance, missing FX, cached offline FX, stale FX and >50-copy provenance.

## Gate output (verbatim excerpts from this execution)
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
`npm run lint` (existing warnings):
```text
✖ 23 problems (0 errors, 23 warnings)
  0 errors and 1 warning potentially fixable with the `--fix` option.


LINT_EXIT=0
```
`npm run test --workspace=@flashydex/core`:
```text
 Test Files  39 passed (39)
      Tests  449 passed (449)
   Start at  15:56:53
   Duration  48.24s (tests 76%, import 23%, worker 1%)
```
```text
CORE_UNIT_EXIT=0
```
`npm run test --workspace=@flashydex/mobile`:
```text
 Test Files  40 passed (40)
      Tests  498 passed (498)
   Start at  15:57:43
   Duration  50.78s (tests 36%, environment 34%, import 18%, setup 10%, transform 1%)
```
```text
MOBILE_UNIT_EXIT=0
```
`cd apps/mobile && FLASHYDEX_E2E_PORT=3221 npx playwright test e2e/pricing.spec.ts e2e/core-flow.spec.ts e2e/routes.spec.ts --project=mobile`:
```text
Running 9 tests using 2 workers
```
```text
  9 passed (1.1m)

E2E_EXIT=0
```

## Scope / execution hygiene
`git diff --stat dc9d7ea..HEAD`: 51 files changed, 3075 insertions(+), 29 deletions(-). Fix range a2a40c0..HEAD: 26 files changed, 922 insertions(+), 166 deletions(-).
Protected-path diff exit 0: no changes under **/src/platform/**, packages/core/src/db/**, scanner/scan/recognition paths, netlify/** or TOP-LEVEL services/**. packages/core/src/services/** pricing/valuation readers intentionally changed; these are not the frozen top-level services tree. Catalog-builder change remains only src/pricing-probe.ts.
Tracked working tree unchanged after all gates/probes; only authored repository file is this report. Tests used synthetic stores/profiles, not owner data. No native-device or production verification; no build requested or run this review.
Cleanup blocker: managed E2E finished; supplementary Vite on 127.0.0.1:3221 remains PID 24860. process_manage kill timed out and orphaned it; graceful taskkill refused, force termination was approval-blocked. Review browser navigated to about:blank; owner's :3200/recognition services untouched.
