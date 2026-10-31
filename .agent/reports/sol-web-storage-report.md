FlashyDex — GPT Sol web-storage architecture report
2026-10-31

Produced (all paths relative to C:/Projects/flashydex)

  docs/WEB-STORAGE.md — new production browser architecture, citations, protocol, migration, activation/recovery, budgets, PWA/cache policy and builder boundaries.
  docs/ARCHITECTURE.md — appended dated web/PWA owner amendment; historical text preserved.
  docs/DECISIONS.md — appended ADR-049–054.
  docs/PHASE1-ACCEPTANCE.md — appended W01–W14 plus physical Safari checklist.
  .agent/reports/sol-web-storage-report.md — this report.

Decision

  Select @sqlite.org/sqlite-wasm in a dedicated Web Worker with explicitly installed opfs-sahpool; initial spike pin3.54.1-build1. No COOP/COEP. packages/core stays unchanged. Capacitor remains for later; primary release is Netlify HTTPS web/PWA, not App Store/TestFlight.

  Reject jeep/sql.js:138 MB raw EN plus one save/export image already requires276 MB decimal before overhead. Normal queries/commits must never load/export a complete catalog. Aggregate page+worker JS heap acceptance X=128 MiB; separately track WASM<=96 MiB and non-double-counted combined target<160 MiB. These are unmeasured release targets, not achieved results.

Important source findings incorporated

  Sahpool capacity counts files/journals/temp/retained generations, not MB. Start16 slots, reserveMinimumCapacity on existing pools. One worker owns USER+0..n catalogs; one physical connection per file. Existing flashydex-user-writer lock is acquired BEFORE any VFS initialization; second tab opens no handles.

  preserveOnInitFailure:true is critical: current SQLite's default initialization-failure cleanup can remove VFS storage. clearOnInit remains false; no wipe/removeVfs recovery.

  Public sahpool has chunked importDb but NO rename. Decode into an ordinary OPFS staged file using chunked sync-handle writes, then import via chunk supplier into a unique closed generation. Activation is a small atomic adapter role-pointer transaction plus the unchanged core PREPARED/receipt journal, not invented OPFS rename or a cross-store atomic transaction. Budget compressed+TWO raw copies during import; old catalog stays intact.

  Inspected chunked import selects a free SAH without reserving it until completion. Pre-associate a closed candidate slot, or hold a verified VFS-wide admission barrier, so concurrent USER journal allocation cannot reuse that handle. importDb also rewrites WAL header bytes; require DELETE header1/1 before import to preserve the verified digest. Stale candidate cleanup must never unlink a promoted active/previous generation.

  Safari17/18 browser/Home Screen quotas are up to60% per origin/80% overall, not guaranteed free space; embedded non-browser WKWebView15%/20% is different. ITP's seven-day rule counts days of Safari use without site interaction, not seven elapsed days. Request/display actual persist() state and offer Home Screen installation; do not promise persist() universally bypasses ITP or protects against user deletion/private-session closure. External backup remains necessary.

  Production PWA needs shell/worker/WASM/offline precache, network-only/no-store manifests/packs, byte-bounded SW image LRU with ledger/reservation/crash reconciliation, and PROMPT updates rather than autoUpdate. A maxEntries cache is not a byte cap. No existing Diagnostics screen was found in inspected source; integrate one rather than assuming it exists.

Verified

  Started with cd C:/Projects/flashydex and read the requested governing documents and actual driver/installer/locking/mark seams.

  curl -L --fail retrieved SQLite persistence.md/api-oo1.md, npm registry and pinned README/bundle/types, MDN OPFS/SAH/per-method compatibility, WebKit quota/ITP articles, MDN persistence/eviction, Cache.put and Vite PWA prompt documentation. Registry returned3.54.1-build1. caniuse HTML returned406; raw feature JSON succeeded. Incorrect guessed source/bundle URLs returned404 and were replaced with verified paths. Broad caniuse File System Access support is not used as proof of OPFS worker compatibility.

  Verification command:
    python C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/verify_sol_web_docs.py
  Result: PASS,50/50 documentation checks; exit0. Checks cover append-only preservation, ADR uniqueness/range, W01–W14, required topics, arithmetic, local links, diff whitespace, evidence files and unchanged packages/core. Final results are recorded in:
    C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/sol-web-storage-evidence/doc-verification.json

  git diff --check and git diff --name-only -- packages/core are included in verification. Other agents changed unrelated worktree paths concurrently; they were not edited/reverted by this task. Only the five assigned repository documentation/report files were written here. No application code, commit, push, deployment or dev server.

Precise Sonnet task split (proposed assignments, not agents launched)

  Sonnet A — own new apps/mobile/src/platform/web-sqlite/**: worker/protocol/WebSqliteWorkerDriver, pool lifecycle, physical-connection queue/refcounts, USER legacy migration. Consume existing SqlDriver unchanged; prove positional/RETURNING/transaction/reopen parity.

  Sonnet B — own platform/pack-install/web-store.ts, new ordinary-OPFS staging/role-store modules, platform/app-database.ts web branch and pack worker integration. Single owner of shared role store; coordinate USER migration interface with A. Adapt existing CatalogSource/CatalogInstallPort, streaming import and core-journal activation/rollback; preserve native/direct-refresh paths. No concurrent A edits to app-database.ts.

  Sonnet C — own new apps/mobile/src/platform/pwa/** plus assigned platform image-cache/protection facade: SW shell/network routes, byte-LRU ledger/reconciliation, persist/install/update controller and UI-facing diagnostic data. No SQL or pack caching; coordinate platform/files.ts ownership.

  Director must separately assign package/lockfile, Vite injectManifest/prompt/WASM packaging, bootstrap/SW registration, Diagnostics/Settings/install UI, Netlify config and tests outside platform. Platform-only builders are not authorized to edit those files. GPT Sol follow-up reviews core-unchanged/parity/fault evidence.

Incomplete / open execution questions

  No driver, installer or SW implemented by this docs-only role. No real138 MB pack browser install, Playwright performance/fault run, Netlify read-back or physical Safari benchmark performed; no acceptance gate marked passed.

  Resolve streaming codec/hash versions and trace hidden buffers; prove chunk-import reservation and cross-store recovery under kill/quota/short-write faults; verify migration variants/oversized USER recovery; measure actual EN bytes/count/hash, all-worker memory and mid-range-phone startup/search. Verify Safari-tab/Home Screen container sharing and actual persistence heuristics on iOS17/18. Native workflows remain manual later. These are execution gates, not reasons to revert to sql.js or weaken the memory rule.
