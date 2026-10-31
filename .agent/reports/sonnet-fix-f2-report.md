# sonnet-fix-f2 report (append-only, stop-safe)

## 1. Validation speed — DONE
Change: apps/mobile/src/platform/web-sqlite/client.ts DEFAULT_CACHE_KIB.validation 1024 -> 32768 (catalog 4096, user 2048 unchanged).
Validation connection is already closed right after validation (web-store.ts openValidationDriver close() -> client driver close; legacy-migration withReadDriver closes in finally). No B file touched.
Command: FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/full-install.spec.ts --project=mobile --timeout=600000
Before (director, same UI path): validate 127.4 s, total 157 s.
After: fdx:pack-validate 52.6 s; download 0.65 s, decode 12.7 s, import 4.9 s, activate 1 ms; install total (click -> "English catalog ready") 72.6 s.
(Caveat: runs not under identical machine load; direction matches native 10.9 s -> 6.6 s ratio plus less contention.)
Heap: page peak 29.4 MB, SQL worker 9.8 MB, decode worker 2.0 MB, aggregate 35.5 MB (< 128 MiB). Storage usage 138.8 MB (raw 138.0 MB). Search Umbreon 2.3 s first / 1.8 s after reload, 30 rows. Startup gate-total 1.16 s.
full-install.spec.ts PASSES against :3200 (1.5 min).
