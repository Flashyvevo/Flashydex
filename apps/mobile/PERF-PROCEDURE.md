# On-device performance measurement procedure (R12)

Procedure only. No numbers are recorded here and none may be quoted from the Node tests in `packages/core/test/perf.test.ts`:
those are Node-only and do not cross the Capacitor bridge. This implements PHASE1-ACCEPTANCE criteria 63-65 on a real device.

## Setup
1. Release-like build on a physical iPhone and a physical mid-range Android phone (not a simulator/emulator). Airplane mode off for install tests, on for read tests.
2. Seed with the REAL full EN (and JA) packs installed through Settings -> Catalog (not the dev pack), then add **10,000 owned copies** across
   many sets (one script/import of a generated `.json` export, so the data is reproducible; record the file's SHA-256).
3. Also seed the giant-group case (one card with hundreds of copies) and the many-groups case (50+ distinct grouped tiles on a page).
4. Dev builds print `[fdx] startup ...` and mark `fdx:*` User Timing measures (`fdx:gate-total`, `fdx:db-open`, `fdx:services`, plus per-query
   measures from core's `timed()`); read them with Safari Web Inspector (iOS) / `chrome://inspect` (Android) via
   `performance.getEntriesByType('measure').filter(m => m.name.startsWith('fdx:'))`.

## Per query
For each of: collection grouped page 1, collection page N (offset deep), search by name, search by number, set page, card detail with copies,
dashboard totals, whole-group-ID lookup, add one copy, bulk add 100:
- run **10 warm-up** iterations, discard them;
- run **100 measured** iterations from a script in the JS console or a dev-only route (cold-start numbers are a separate, labelled series);
- record **p50, p95 and max** in ms from `performance.now()` deltas around the service call, and the same for the bridge-inclusive UI path (tap -> rows painted
  via a `PerformanceObserver` on `paint`/`event`);
- store raw samples as JSON next to the report; compute percentiles from the raw samples, never by eye.

## Long tasks and responsiveness during write-heavy work
Run a `PerformanceObserver({ type: 'longtask', buffered: true })` (Chromium/Android WebView; on iOS use Web Inspector Timelines -> JavaScript & Events)
while each of these runs, and record count, total, and the worst long-task duration:
- catalog install (worker decode -> staged write -> core validate -> activate), at the real EN pack size;
- user DB flush on web / native commit during bulk add of 100 and during an import of 10k rows;
- `.fdx` create and restore at 10k copies.
While those run, tap/scroll the collection and record input-to-paint latency (`PerformanceEventTiming` `processingStart - startTime` and duration >= 16 ms count).

## Memory
- Install the real EN pack and watch the worker + main-thread peak (Xcode Instruments Allocations/VM Tracker; Android Studio Profiler). The page reports
  `pendingBytesMax` (decoded bytes queued/unacknowledged inside the worker) in the install metrics; it must stay <= the 32 MiB hard cap and
  settle near the 4 MiB ack cap. `peakMemoryBytes` is intentionally `null` in app metrics because JS cannot observe native RSS; paste the Instruments peak into the report instead.
- Never certify the "never hold the whole catalog" rule from the tiny dev-pack run.

## Recording
Write results in a dated report: device model, OS version, build id, pack versions, seed hash, raw sample files, then the p50/p95/max table per query and the long-task table.
A criterion is closed only when the numbers come from a device run under this procedure.

## Stage F — web storage (2026-10-31)

Release thresholds (WEB-STORAGE §6): aggregate used JS heap across page + SQL worker + decode worker < 134,217,728 B during a real full-EN install; committed WASM separately ≤ 96 MiB; search p95 < 300 ms; `fdx:gate-total` ≤ 1,200 ms on the documented phone.

**Install time + storage.** Use the release build (`npm run build`, then `npx vite preview --host 0.0.0.0 --port 3202 --strictPort`, served over https for a phone, or the Netlify preview). Onboard, install EN, read Settings → Import, export & backup → Diagnostics → "fdx timings": `fdx:pack-download`, `fdx:pack-decode`, `fdx:pack-import`, `fdx:pack-validate`, `fdx:pack-activate` (ms) and "packMetrics" (raw bytes, max chunk ≤ 262,144, pending high-water). Total = wall clock from "Start download" to the "English catalog ready" text; the Playwright spec `e2e/full-install.spec.ts` records it. After install, `navigator.storage.estimate().usage` must be < 1.5 × raw pack bytes (138,002,432 for the current EN pack).

**Heap on desktop Chromium (automated).** `FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/full-install.spec.ts --project=mobile` samples `performance.memory.usedJSHeapSize` every ≤ 50 ms for the page and attaches CDP (`Target.setAutoAttach` flatten) to every worker target for `Runtime.getHeapUsage`. The report lines print page peak, per-worker peaks and the aggregate. If a worker target cannot be sampled the spec records `null` plus a reason (never an invented number).

**Heap on device.** Safari (iOS 17/18): Settings → Advanced → Web Inspector, connect to a Mac, Develop → device → page; Timelines → Memory + JavaScript Allocations while installing; repeat for each Worker target listed under the page. Android Chrome: `chrome://inspect` → inspect page and each worker, Performance monitor → JS heap size. Report values as measured; unobservable → null + reason (gate stays open). Diagnostics shows `wasmMemoryBytes` for the SQL worker (WebAssembly memory.buffer size) and the main `performance.memory` where Chromium exposes it; do not add them together with the page-cache setting (SQLite's page cache lives inside the WASM memory).

**Search timing.** With the provider/network off (DevTools offline), run 10 warm-ups + 100 samples of exact/prefix/contains/language/set/rarity queries through the UI search service (`window.__flashydexTest.services` in dev builds, or a dev route) and compute p50/p95/max from raw `performance.now()` deltas, as in "Per query" above. Row count: 23,736 EN cards in the current pack.

**Cold start.** 10 cold launches of the installed PWA with USER + EN present and no network: record `fdx:gate-total`, `fdx:storage-prepare`, `fdx:db-open`, `fdx:services` from Diagnostics, and navigation → interactive Dashboard.
