# sol-review-5 — independent Stage F review (production web storage) + ADR-055

Unattended run. Never ask questions. Read-only review: you write ONLY `.agent/reports/sol-review-5.md`. Repo `C:/Projects/flashydex` (start every shell with `cd C:/Projects/flashydex`). Do not commit, push, stash, or edit any other file. Do not start/kill servers; the owner's dev server is at `https://127.0.0.1:3200` if you need a browser check (text/DOM only; no screenshots).

## What to review
Stage F replaced the in-memory jeep-sqlite web path with sqlite-wasm opfs-sahpool in a worker + OPFS pack staging + IndexedDB role store + atomic activation. Your prior reviews are `.agent/reports/sol-review.md` … `sol-review-4.md`; your design is `docs/WEB-STORAGE.md`; the director's seams are `.agent/stage-f-contract.md` (+ `apps/mobile/src/platform/web-storage/contract.ts`). Builder reports: `.agent/reports/sonnet-web-sqlite-report.md`, `sonnet-web-install-report.md` (read "Run 2"), `sonnet-pwa-report.md`, `sonnet-shell-f-report.md`. Two Sonnet fix children are running concurrently on `e2e/web-install.spec.ts`, `e2e/persistence-failed.spec.ts`, `e2e/pack-install.spec.ts`, `routes/dev/**` — ignore those files' state; review the product code.

Director findings since those reports (verified by the director in Chromium):
- Full EN install through the real onboarding UI passes: 16.5 s total (download 0.4 / decode 7.9 / import 3.2 / validate 4.0), aggregate JS heap peak 35 MB, storage 121.7 MB, search + reload OK (`e2e/full-install.spec.ts`).
- The validate phase was 37–120 s with 4 KiB pages because each page is one synchronous OPFS read (~0.3 ms). **ADR-055** (`docs/DECISIONS.md`, `tools/catalog-builder/src/build-db.ts` `CATALOG_PAGE_SIZE = 65536`) moves packs to 64 KiB pages. Review this decision for correctness and risk (sahpool `importDb` with 64 KiB pages, header checks at bytes 16–19, B's decoder ≤256 KiB chunks, A's `cacheKiB` meaning, native Capacitor SQLite, future delta packs, older 4 KiB packs still installable).

## Required scope (binding per BRIEF: pack integrity, manifest trust, atomic activation, data-loss risk)
1. **Core unchanged**: `git diff --stat HEAD -- packages/core` must be empty; confirm and state it.
2. **Atomic activation & rollback on web** (`web-storage/role-store.ts`, `role-state.ts`, `reconcile.ts`, `pack-install/web-store.ts`, `web-port.ts`, `app-database.ts`): walk every WEB-STORAGE §4 crash row and the §5 recovery table against the code. Specifically: can any path unlink `/user`, the active ref, or the previous ref before the pointer transaction commits? Can `reconcileWebStaging` or stale-candidate cleanup remove a promoted generation? Is `WEB_ATOMIC_ACTIVATION_PROVEN = true` justified by the evidence in B's report, or must it be false until the v2/kill browser specs pass?
3. **Import integrity** (`web-sqlite/worker-core.ts`, `client.ts`, `opfs-stage.worker.ts`): SHA-256 verified over the exact bytes fed to `importDb`; header bytes 18/19 forced to 1 before hashing (or hashed after?) — is the verified digest the digest of the file that ends up in the pool? Pre-associated slot reservation vs concurrent USER journal allocation (your "admission barrier" item). Short write / quota / kill behaviours.
4. **USER migration** (`legacy-migration.ts`): one-time jeep→sahpool migration must never lose or duplicate personal rows; blocked cases fail closed; legacy key untouched. Check the "role without marker + legacy key present → existing" deviation A reported (§5 says block).
5. **Durability**: synchronous=FULL + journal DELETE through sahpool; COMMIT/barrier failure → latch, `reopen()` no replay; worker death detection (A notes no heartbeat — is a hung promise a data-loss or just a hang?).
6. **Trust**: `catalog-config.ts` default trusted origin is only `https://flashydex-catalog-packs.netlify.app`; manifests/packs must be network-only in the SW (`pwa/routes.ts`), never cached; any present signature still rejected.
7. **Memory**: ADR-054 budgets vs the measured numbers above; anything that could still allocate catalog-sized buffers on the main thread.
8. Run the gates yourself and record real output: `npm run typecheck`, `npm run lint`, `npm test --workspace=@flashydex/core`, `npm test --workspace=@flashydex/mobile`.

## Report shape (`.agent/reports/sol-review-5.md`)
- Verdict: ship-ready for the web/PWA production path? (yes / yes-after-P1s / no), one paragraph.
- Findings table: id, severity P0/P1/P2, file:line, what, why it matters, concrete fix.
- ADR-055 assessment (accept / accept-with-conditions / reject) with reasons.
- W01–W14 status table (closed / partial / open) with the evidence you actually inspected.
- `[needs owner input]` list (physical Safari/iOS evidence etc.).
Cap at ~400 lines. No fabricated measurements: if you did not run it, say so.
