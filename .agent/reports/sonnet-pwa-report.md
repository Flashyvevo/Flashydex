# sonnet-pwa (builder C) report — Stage F

Marker: `.agent/stage-f-C-ready` touched (exports compile, 92 unit tests pass, real-browser smoke passes).

## Files (all mine)
apps/mobile/src/platform/pwa/: sw.ts, sw-core.ts, routes.ts, precache.ts, env.ts, env.d.ts, protection.ts, install.ts, update.ts,
image-controller.ts, copy.ts, index.ts, harness.ts, sw.test.ts, controllers.test.ts,
image-cache/{types,engine,read-bounded,handler,messages,idb-ledger,test-fakes}.ts, image-cache/engine.test.ts.
Also: platform/files.ts (imageCache section + one import), e2e/pwa-image-cache.spec.ts, e2e/pwa-sw-smoke.spec.ts.

## Proven (commands)
- `npx vitest run src/platform/pwa` -> 3 files, 92 tests pass (engine fakes, route table, precache, fetch router, handler, messages, controllers).
- `FLASHYDEX_E2E_BASE_URL=https://127.0.0.1:3200 npx playwright test e2e/pwa-image-cache.spec.ts --project=mobile` -> 1 passed (REAL Cache Storage + IndexedDB + Web Lock, 5000 B limit).
- Production build (`vite build` to a scratch outDir with shell-f's config): sw.js generated, 87 precache entries incl. index.html + sqlite3-*.wasm, no dev-packs/.zst/.db, no import/export in sw.js.
- `FLASHYDEX_SW_URL=http://127.0.0.1:3290 npx playwright test e2e/pwa-sw-smoke.spec.ts --project=mobile` (static server on that build) -> 1 passed: SW controls page after first install (claim on first install only), one precache cache, offline deep link `/settings/data` returns the shell, image admitted by the SW ledger (stats enforced:true, committed = body bytes) and served offline, catalog-manifest/dev-packs fetches fail offline (network only), missing .wasm/.js never HTML, only `flashydex-precache-*` and `flashydex-images-v1` caches exist, no pack URL in any cache.
- Gates: root typecheck — my files clean; remaining errors are not mine (web-store.test.ts:297 [B], web-sqlite/testing/memory-env.ts:18 [A]). eslint on pwa/ + files.ts: 0 problems (full lint has 5 errors in routes/ [shell-f]). core tests 367/367. Full mobile suite: 3 failures all in B's web-store test; pwa tests green.
- Cleanup note: a python static server I started on :3290 (scratch dist) may still be running; harmless, not :3200/3201.

## Acceptance evidence
| id | evidence | status |
|---|---|---|
| W07 | protection/install controllers: persisted true/false/reject/missing, request() never claims a prompt, localStorage snapshot+requested, visibilitychange recheck only standalone; iOS/iPadOS/Android/desktop detection, standalone hides banner, beforeinstallprompt captured, 14-day snooze; copy.ts names SEVEN DAYS OF SAFARI USE (test asserts, and no "accepted"). controllers.test.ts | unit closed; UI/diagnostics display + real Safari behaviour = shell-f/manual |
| W11 | routes.ts table tests; sw-core router tests; real SW smoke (above): offline deep link -> shell, packs/manifest/api network-only never cached, worker/WASM miss never HTML, activate deletes only own precache caches | closed for SW; Netlify headers/redirect readback = shell-f on real host |
| W12 | engine.test.ts: cap at every ledger write under 40 concurrent admits, LRU+touch, oversized/404/html/opaque/lying+missing Content-Length, crash at reserve/put/commit + reconcile, quota retry-once-then-disable, setLimit shrink before ACK, clear, TTL 30d + markFresh; real-store spec; real SW stats ACK | closed except real SW termination mid-put and real quota (cannot be forced from Playwright) |
| W13 | update.ts: lazy register only in PROD, prepare-before-skipWaiting, prepare throws => nothing activates + error, exactly one reload, activation timeout leaves app usable, other-tab controllerchange reloads once, first-install claim doesn't reload | unit closed; dirty-form/lock/handoff e2e = shell-f |

## Design notes / deviations
- No webworker lib conflict: sw.ts declares its own minimal `SWScope` types; all logic in DOM-free modules. No new deps (hand-rolled precache; workbox NOT imported).
- First install: SW calls `clients.claim()` ONLY when there was no previous active worker (flag set in install). Updates never claim and never skipWaiting except on the `SKIP_WAITING` / `fdx:sw:skip-waiting` message.
- `readBounded` does not await `reader.cancel()` (on a tee'd clone it waits for the other branch; awaiting hung tests).
- Image admission reads are serialized (one ≤2,000,000 B buffer at a time); a Content-Length > cap is used only to skip work, never to admit. Conditional revalidation sends If-None-Match only if the server's ETag is CORS-readable.
- `later()` hides the toast (needRefresh=false); the waiting worker is re-detected on next load.
- Before the first check, `ProtectionSnapshot.checkedAt === null` (persist is a placeholder: show "not checked yet").
- imageCache message shape for setLimit: `{type:'fdx:image-cache:set-limit', v:1, id, bytes}`; ACK `{type:'fdx:ack', v:1, id, ok, stats?, error?}`.

## Contract change requests
None required. (Optional: `UpdateState`/`ProtectionSnapshot` have no "not checked" value; I use checkedAt:null.)

## Integration requests for shell-f
shell-f's current vite.config.ts already matches. Verbatim expectation:
```ts
VitePWA({
  strategies: 'injectManifest', srcDir: 'src/platform/pwa', filename: 'sw.ts',
  registerType: 'prompt', injectRegister: false,
  injectManifest: { globPatterns: ['**/*.{js,css,html,wasm,woff2,png,svg,webmanifest}'], globIgnores: ['**/dev-packs/**','**/*.zst','**/*.db'], maximumFileSizeToCacheInBytes: 3*1024*1024 },
  devOptions: { enabled: false }
})
```
- Registration: `installController.start(); updateController.register();` in main.tsx (register is a no-op unless `import.meta.env.PROD`). Types for `virtual:pwa-register` already come from pwa/env.d.ts (and your lib/pwa-types.d.ts).
- Headers: `/sw.js` Cache-Control no-cache (already in _headers), `/index.html` no-cache, `/manifest.webmanifest` no-cache; keep `/*.wasm` Content-Type application/wasm. Do NOT cache `/catalog-manifest.json`. Keep `/* /index.html 200` — the SW converts HTML answers for code URLs into 404.
- Deps: none to add (workbox not imported). vite-plugin-pwa 2.0.0 stays.
- Build artifact note: sw.js is emitted as an ES-format single chunk with no import/export, so it registers as a classic worker.
- shell-f e2e scenarios on a production build: run `e2e/pwa-sw-smoke.spec.ts` with FLASHYDEX_SW_URL set to `vite preview`; additionally (not done by me): (1) deploy v1, load, deploy v2 -> waiting worker, `needRefresh` true, Later keeps old UI, Restart runs prepare then exactly one reload (count `performance.getEntriesByType('navigation')`); (2) two tabs: apply in tab A, blocked tab B reloads once; (3) prepare rejecting leaves `registration.waiting` untouched; (4) kill the SW (chrome://serviceworker-internals or CDP `ServiceWorker.stopAllWorkers`) mid image admission, restart, `imageCache.stats()` shows reservedBytes 0 and cache keys == ledger; (5) setLimit(150_000_000) after filling; (6) offline reload of a lazy route + worker/WASM start offline; (7) Settings "Offline card art" shows `enforced:false` with reason `no_service_worker` in dev and on first uncontrolled load.

## Open risks
- Real Safari/iOS SW + Web Locks in SW behaviour unverified (Chromium only). Web Lock absence degrades to the SW-local queue only.
- Real QuotaExceededError path is unit-tested with fakes only.
- Tee buffering for a huge uncached image body is bounded only by Content-Length hint skip; pathological servers without CL could buffer in memory until read (read stops at 2 MB).
