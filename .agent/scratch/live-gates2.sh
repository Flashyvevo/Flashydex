cd C:/Projects/flashydex/apps/mobile
O=../../.agent/scratch/live-gates2
mkdir -p $O
: > $O/summary.txt
for i in 1 2; do FLASHYDEX_E2E_PORT=3211 npx playwright test e2e/scanner.spec.ts --project=mobile --reporter=line > $O/scanner$i.txt 2>&1; echo "scanner run $i exit $?" >> $O/summary.txt; done
FLASHYDEX_E2E_PORT=3212 npx playwright test e2e/routes.spec.ts e2e/core-flow.spec.ts --project=mobile --reporter=line > $O/routes-core.txt 2>&1; echo "routes+core exit $?" >> $O/summary.txt
FLASHYDEX_E2E_PORT=3211 npx playwright test e2e/scanner-live.spec.ts --project=mobile --reporter=line > $O/live2.txt 2>&1; echo "live run 2 exit $?" >> $O/summary.txt
echo DONE >> $O/summary.txt
