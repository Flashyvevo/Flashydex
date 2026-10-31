FlashyDex — GPT Sol Stage A2 architecture report

Status
  A2 App Store/local-first rewrite completed and documentation checks passed. Current owner storage design is NOT complete: BRIEF gained a newer 2026-10-31 compression/storage update during this run. It supersedes A2 single-DB, crawl-primary, snapshot-later and JSON-plus-raw-backup assumptions. Affected docs carry precedence notices; ADR-039 hands off the separate A3 multi-DB/zstd/.fdx work rather than pretending it was covered here.

Changed
  docs/ARCHITECTURE.md — apps/mobile + packages/core/schemas + optional recognition layout; Vite/React/Capacitor layers, startup/migrations/settings, identical sqlite-proxy test path, foreground resumable sync, native CapacitorHttp/web fetch, storage estimates, art policy, optional-server seams and App Store/privacy constraints.
  docs/DATA-MODEL.md — retained copy/identity/enums/FK safety; added app_settings, schema_migrations, published/unpublished status, raw variant flags including w_promo, checkpoint v2 with per-set progress, compatible driver/migration rules and research-grounded qualified-print price mapping. A2 schema has 17 tables; A3 must split their placement/FKs.
  docs/API.md — replaced HTTP endpoints with CatalogRepo, CollectionRepo, SyncService, PortfolioService, TransferService, SettingsRepo, BackupService and Platform interfaces, named zod inputs/results/errors. Grouped collection is binding: one tile per language/cardId/variant, quantities and copy IDs; complete filters, no-price/Pocket, bulk add, valuation coverage, local transfer and capability-gated backup.
  docs/IMPORT-EXPORT.md — native Filesystem/Share, web Blob/picker, private local preview/commit and receipt recovery. JSON v1 schema blocks and exact 45-column CSV header unchanged. A3 must add .fdx backup without silently changing interchange v1.
  docs/PHASE1-ACCEPTANCE.md — retained 68 criterion IDs; repository-level tests, offline launch/editing, onboarding, safe areas, VoiceOver/rem text scaling, branding/privacy, native/share/persistence checks and on-device search budget. Web-dev measurement method specified.
  docs/DECISIONS.md — appended ADR-022 through ADR-039; old server ADRs explicitly historical/superseded.

Verified
  curl -fL --retry 2 fetched Capacitor docs/v7 HTTP/Filesystem/Share, SQLite README/API plus v7.0.3 README/API/definitions, and Drizzle sqlite-proxy driver/session sources successfully. Source URLs are in ARCHITECTURE.md. Findings: plugin suffix changes physical DB name; documented v7 web persistence is IndexedDB, not guaranteed OPFS; run/query are single-statement; explicit transactions exist; RETURNING parity is not assumed; raw native online backup is not a universal plugin API.
  From C:/Projects/flashydex:
    python C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/flashydex-sol-a2/audit_docs.py
      Exit 0: zero stale-name matches, local Markdown references resolve, all eight interfaces present, 38 input-schema references resolve, 17 A2 tables, 68 acceptance IDs, 39 ordered ADRs, transfer schema blocks/header unchanged against 17f7f87, no missing active UX routes.
    node C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/flashydex-sol-a2/check_doc_syntax.cjs
      Exit 0: TypeScript 5.9.3 parsed 13 documentation code blocks with zero syntax errors. Syntax check only, not semantic typecheck or app tests.
    git diff --check -- docs/ARCHITECTURE.md docs/DATA-MODEL.md docs/API.md docs/IMPORT-EXPORT.md docs/PHASE1-ACCEPTANCE.md docs/DECISIONS.md
      Exit 0.

UX follow-up
  No existing screen URL renamed. Included /custom-cards/new and /settings/locations; /scan remains absent in Phase 1.
  Replace old HTTP calls/maintenance health polling and PC-running-sync copy with core hooks/foreground-device behavior. Grouped grid is required, not fallback; wire localId/value/count/collecting/Pocket/no-price controls. Map URL aliases to typed inputs. Default condition is unknown, not NM; do not silently pad collector IDs. Rename stale localStorage/token keys in UX-owned files. Raw restore must not appear usable without capability; JSON import is merge/update, not replacement. Latest A3 setup/pack/.fdx UX still needs alignment.

Open / tooling handoff
  A3: separate user/catalog DBs, cross-DB join strategy, primary zstd pack pipeline/atomic installer, .fdx settings-aware backup, image-cache interface and pack metrics remain outstanding under newer BRIEF. Do not implement superseded A2 storage choices as current owner intent.
  Terra must prove actual plugin row-shape/transaction/migration/reopen parity, web saveToStore/quota recovery/single-writer behavior, raw-copy/replace capabilities, private file picker/staging/share and physical filename handling. No guaranteed native HTTP abort or web-readable ETag is assumed.
  Mac/device build, VoiceOver/Dynamic Type, native share, real catalog footprint/search timings and App Store privacy/encryption declarations were not executed by this documentation task. The 25 MiB interchange cap also needs large-history stress testing; don't claim all maximum-row exports will fit it.

Scope
  Only the six owned docs and this report were edited in the repo. No app code or UX/BRIEF/SPEC/compliance documents edited, no commit/push, no dev server started. Scratch contains source captures and documentation-audit scripts. Other agents/director changed the working tree during this run; their changes were not reverted.

Report: C:/Projects/flashydex/.agent/reports/sol-architecture-v2-report.md
