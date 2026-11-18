cd C:/Projects/flashydex
O=.agent/scratch/live-gates
mkdir -p $O
: > $O/summary.txt
npm run typecheck > $O/typecheck.txt 2>&1; echo "typecheck exit $?" >> $O/summary.txt
npm run lint > $O/lint.txt 2>&1; echo "lint exit $?" >> $O/summary.txt
npm test --workspace=@flashydex/mobile > $O/unit.txt 2>&1; echo "unit exit $?" >> $O/summary.txt
cd apps/mobile
for i in 1 2; do FLASHYDEX_E2E_PORT=3211 npx playwright test e2e/scanner.spec.ts --project=mobile --reporter=line > ../../$O/scanner$i.txt 2>&1; echo "scanner run $i exit $?" >> ../../$O/summary.txt; done
FLASHYDEX_E2E_PORT=3211 npx playwright test e2e/scanner-live.spec.ts --project=mobile --reporter=line > ../../$O/live1.txt 2>&1; echo "live run 1 exit $?" >> ../../$O/summary.txt
FLASHYDEX_E2E_PORT=3211 npx playwright test e2e/routes.spec.ts e2e/core-flow.spec.ts --project=mobile --reporter=line > ../../$O/routes-core.txt 2>&1; echo "routes+core exit $?" >> ../../$O/summary.txt
echo DONE >> ../../$O/summary.txt
