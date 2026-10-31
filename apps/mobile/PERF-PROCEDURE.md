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
