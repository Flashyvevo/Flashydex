# Stage D — binding cross-package contract (Claude Opus director, 2026-10-31)

Two Sonnet builders run IN PARALLEL: `sonnet-core-d` (packages/core, packages/schemas, tools/catalog-builder, .github/workflows) and
`sonnet-mobile-d` (apps/mobile). Neither waits for the other. Both code against THIS file. The core child implements the
interfaces below in core; the mobile child implements the adapter side in apps/mobile and calls the new core methods.
If the core child must deviate, it writes the exact change into `docs/API.md` under a new dated
`## Director notes — Stage D (2026-10-31)` section AND into `.agent/reports/sonnet-core-d-report.md` "Contract deviations".
Names here are binding; small additive optional fields are fine.

Director decisions for this round (also logged in `.agent/DIRECTOR-DECISIONS.md` as D40–D46 by the director):

- D40 (.fdx restore activation). Restore is an IN-PLACE single USER-DB SQLite transaction: inside one `BEGIN IMMEDIATE`
  transaction delete every personal table's rows and insert the archive rows (original UUIDs/audit times), update
  app_settings, bump collection_revision, write a `restore_receipts` row; then the normal afterCommit flush (web
  saveToStore = one IndexedDB put of the whole DB). SQLite journaling (native) / single IDB put (web) make it atomic, so no
  file rename/swap seam is needed. Operational tables (installed_catalogs, catalog_install_jobs, sync_runs, migrations,
  import receipts) are kept from the device, never taken from the archive. Safety .fdx of current state is created and
  verified (re-read + re-hash) BEFORE the transaction. Preview validates in JS (zod strict + cross-row refs + counts + hashes)
  with zero DB writes. This supersedes the file-swap wording in IMPORT-EXPORT step 4 for Phase 1.
- D41 (ZIP library). `fflate` (pure JS, no DOM/Node imports) in packages/core for .fdx ZIP write/read; DEFLATE level 6 for JSON.
  Streaming caps enforced on actual inflated output (not central-directory sizes).
- D42 (Web Locks). Web build takes `navigator.locks.request('flashydex-user-writer', {mode:'exclusive', ifAvailable:true})`
  and holds it for the page lifetime. Not granted → INSTANCE_LOCK screen. `navigator.locks` undefined (it is
  secure-context-only, so plain-HTTP LAN origins hit this) → app opens but ALL personal writes are refused with INSTANCE_LOCK
  and a banner explains why (use https or localhost). Native does not need the lock.
- D43 (persistence latch). After an afterCommit flush failure the user Db latches `persistence_failed`: every further
  transaction throws PERSISTENCE_FAILED until `services.storage.recover()` succeeds (driver.reopen() → re-read persisted
  state; then latch clears) and the UI refetches everything.
- D44 (native writable catalog). Native catalog writes use a copy in the SQLite plugin's writable DB directory opened via
  `createConnection`; NC stays read-only for validation. Not proven without a Mac → native `catalogWrites:false`
  (prices_only/refresh/incremental report unsupported on native) with a TODO + scripts/ios-notes.md steps.
- D45 (one admission coordinator). Install, uninstall, rollback, sync start/resume and .fdx restore all go through one core
  `WorkCoordinator` with one durable admission row; per-language maintenance barrier + generation fencing.
- D46 (manifest trust). Trusted origins list is configuration passed from the app into core; core does all semantic validation.

## 1. CatalogInstallPort v2 (packages/core/src/services/catalog-install.ts — replaces v1)

```ts
export interface PackStageResult {
  language: 'en'|'ja'; version: string;
  sha256: string;            // of decompressed bytes, already verified == entry.sha256 by the adapter
  bytes: number;             // decompressed byte count, verified == entry.uncompressedBytes
  candidateRef: string;      // opaque staged candidate (NOT active yet)
  metrics: unknown;          // DeviceInstallMetrics incl. pendingBytesMax (R05)
}
export interface PackDiskState {
  activeRef: string|null;     // from disk / store, never from memory
  previousRef: string|null;   // retained previous copy discovered on disk (survives restart)
  candidateRefs: string[];    // staging leftovers for that language
}
export interface CatalogInstallPort {
  readonly allowDevUrls: boolean;
  capabilities(): { fullInstall:boolean; atomicActivation:boolean; attachReads:boolean; catalogWrites:boolean; reason:string|null };
  /** Bounded streaming read of the configured manifest. Adapter stops reading at maxBytes and throws PAYLOAD_TOO_LARGE.
   *  finalUrl = response.url after redirects (core checks it against trustedOrigins). */
  fetchManifest(input:{ maxBytes:number }, signal?:AbortSignal): Promise<{ text:string; finalUrl:string; requestedUrl:string }>;
  /** Download + zstd decode (bounded, R05) + SHA-256 + staged write. No activation. Adapter rejects a final response.url
   *  whose origin is not in trustedOrigins (passed in) with PACK_INVALID. */
  stage(entry: PackEntry, options:{ trustedOrigins:string[]; onProgress:(p:PackInstallProgress)=>void; signal?:AbortSignal }): Promise<PackStageResult>;
  /** Read-only SqlDriver over a staged candidate OR the active file (ref from stage()/inspect()). Core runs ALL validation SQL. */
  openForValidation(ref: string): Promise<SqlDriver>;
  /** candidate -> active; existing active -> previous (same-volume rename on native; IDB key moves on web). */
  activate(language:'en'|'ja', candidateRef:string): Promise<{ activeRef:string; previousRef:string|null }>;
  restorePrevious(language:'en'|'ja'): Promise<boolean>;   // previous -> active
  discardPrevious(language:'en'|'ja'): Promise<void>;
  discardCandidate(ref:string): Promise<void>;
  inspect(language:'en'|'ja'): Promise<PackDiskState>;       // disk truth for boot recovery (R06)
  remove(language:'en'|'ja'): Promise<void>;
}
```
`PackInstallProgress` keeps its current shape plus optional `pendingBytes?:number`. `CatalogSource` gains
`readonly writable: boolean` (DatabaseSet.canWriteCatalog returns it; function presence no longer counts).
Adapter error codes stay the PackInstallErrorCode strings (+ `PAYLOAD_TOO_LARGE`); core maps them to CatalogError.

Core-side validation (R09) moves into core: `validateCatalogCandidate(driver, entry)` checks catalog_meta (language,
version, schema_version == bundled), exact schema fingerprint (sqlite_master name/type/sql normalized, hashed, compared to a
fingerprint generated from the bundled catalog migrations), object allowlist (no triggers, no views, only expected
tables/indexes), `PRAGMA integrity_check` == 'ok' (transport errors are FAILURES, not swallowed),
`PRAGMA foreign_key_check` empty, foreign-language rows 0, counts == manifest. The mobile installer's own validateCatalog
can be deleted once the adapter only stages (mobile child: delete it, core owns validation).

## 2. Manifest trust (R09) — packages/schemas + core

`createServices` options gain `catalog?: { manifestUrl:string|null; trustedOrigins:string[] }`. Core function
`validateManifestSemantics(raw, ctx:{ requestedUrl, finalUrl, trustedOrigins, allowDevUrls, installed:InstalledCatalog[] })`:
https only (dev may allow same-origin/http when allowDevUrls), finalUrl + every fullPackUrl/setIndexUrl origin ∈ trustedOrigins
(dev adds the page origin), calendar-valid version `YYYY.MM.DD.NNN` with NNN ≥ 001, targetVersion ≥ installed (downgrade →
MANIFEST_INVALID), same version with different sha256 → MANIFEST_INVALID, counts cross-field sane (unpublishedSets ≤ sets,
etc.), `signature` present but unverifiable → MANIFEST_SIGNATURE_INVALID (no keys are shipped in Phase 1, so ANY present
signature is rejected; absent is OK). Manifest maxBytes = 256 KiB.
Mobile default trustedOrigins (apps/mobile/src/platform/catalog-config.ts): `FLASHYDEX_TRUSTED_ORIGINS` env (comma list)
else `['https://github.com','https://objects.githubusercontent.com','https://release-assets.githubusercontent.com']`;
DEV adds `window.location.origin`.

## 3. Persistence + instance lock (R01, R02)

```ts
// SqlDriver gains:  reopen?(): Promise<void>  // discard in-memory state and re-read the persisted DB
type StorageStatus = { writable:boolean; reason:'ok'|'persistence_failed'|'instance_lock'|'maintenance'; message:string|null };
interface Services { storage: {
  status(): StorageStatus;
  subscribe(listener:(s:StorageStatus)=>void): () => void;
  recover(): Promise<StorageStatus>;        // driver.reopen() then clears persistence_failed; throws if reopen unsupported/fails
} }
// createServices option:  userWriteBlock?: { reason:'instance_lock'; message:string }
```
Error codes: `PERSISTENCE_FAILED` (existing PersistenceError), new `INSTANCE_LOCK` (StorageError subclass/ code), new
`MAINTENANCE` already exists (MaintenanceError). While blocked, every mutation (collection, settings, transfer commit,
install, uninstall, sync, restore) rejects with the blocking code; reads, JSON/CSV export and .fdx create still work.
Mobile: web `reopen` = close the jeep connection WITHOUT saving (closeConnection on web saves! — use
`sqlite.closeConnection` only after `deleteConnection`-style discard; if the plugin cannot discard, reopen = full
`location.reload()` path in the UI) — mobile child decides and documents; the UI must never claim a reload it did not do.

## 4. BackupService (R08) — core implements, mobile wires

Signatures exactly as docs/API.md "TransferService / BackupService" (create/previewRestore/restore with optional
`onProgress, signal`; capabilities). `capabilities()` returns `{fdxCreate:true, fdxRestore:true, optionalCatalogPayload:false,
reason:null}` when the platform has filesystem read/write (web + native both do), `includeCatalogs:true` →
UNSUPPORTED_CAPABILITY. create returns BackupResult with a FileRef written via `platform.filesystem.write({area:'exports',
name:'flashydex-<UTC compact>.fdx', mime:'application/vnd.flashydex.backup+zip'})`. previewRestore reads via
`platform.filesystem.read({file,maxBytes:512 MiB})`. restore returns RestoreResult incl. `safetyBackup` FileRef.
Error codes: BACKUP_INVALID, BACKUP_VERSION_UNSUPPORTED, ALREADY_RESTORED, PREVIEW_EXPIRED, STALE_PREVIEW, SIZE_LIMIT.
Schemas live in `packages/schemas/src/backup.ts` (FdxManifestV1, BackupCounts, FdxEntitiesV1, SettingsBackupV1, inputs/DTOs).

## 5. Sync (R07)

`SyncService.capabilities()` becomes `{ pricesOnly:boolean; refresh:boolean; incremental:boolean; reason:string|null }`
(all false when `databases.canWriteCatalog` is false). `start({mode:'refresh'|'incremental', selection})` implemented.
UI: enable "Refresh this set" (useRefreshSet) and any incremental entry when the capability is true.

## 6. Coordinator (R10)

Core-internal. Visible effects the UI must handle: `ACTIVE_WORK` (already mapped) and `MAINTENANCE` while a per-language
barrier is held, and `STALE_READ` (retry once silently in hooks; show generic error after).
