import {
  CheckManifestInput, UninstallInput, type CatalogManifest, type CatalogManifestEntryV1, type CatalogPhase, type CatalogProgress,
  type CatalogStatus, type CatalogUpdateCheck, type InstalledCatalog, type Input
} from '@flashydex/schemas';
import { CATALOG_SCHEMA_VERSION } from '../db/catalog-schema';
import type { WorkLease } from '../db/coordinator';
import type { SqlDriver } from '../db/sql';
import { CancelledError, CatalogError, DomainError, PersistenceError, toDomainError } from '../errors';
import { validateActiveCatalog, validateCatalogCandidate } from './candidate-validation';
import { parse, parseJson, readSettings, type ServiceContext } from './context';
import { MANIFEST_MAX_BYTES, parseManifestText, validateManifestSemantics } from './manifest-validation';

type Language = 'en' | 'ja';
export type PackEntry = CatalogManifestEntryV1 & { language: Language };

export interface PackInstallProgress {
  phase: 'downloading' | 'verifying' | 'validating' | 'activating' | 'installed';
  compressedBytesDone: number;
  compressedBytesTotal: number;
  decompressedBytesDone: number;
  decompressedBytesTotal: number;
  /** Decoded bytes queued behind the writer (R05 backpressure evidence). */
  pendingBytes?: number;
}

/** What the adapter hands back after download + bounded zstd decode + SHA-256 + staged write. Nothing is active yet. */
export interface PackStageResult {
  language: Language;
  version: string;
  /** SHA-256 of the decompressed bytes, already verified == entry.sha256 by the adapter (core re-checks). */
  sha256: string;
  /** Decompressed byte count, verified == entry.uncompressedBytes by the adapter (core re-checks). */
  bytes: number;
  /** Opaque staged candidate (NOT active yet). */
  candidateRef: string;
  metrics: unknown;
}

/** What is actually on disk for one language: boot recovery reads this instead of trusting memory (R06). */
export interface PackDiskState {
  activeRef: string | null;
  previousRef: string | null;
  candidateRefs: string[];
}

/** Platform port v2 (Stage D contract §1): the only way core touches pack files. Core stays free of Capacitor/DOM/Node. */
export interface CatalogInstallPort {
  readonly allowDevUrls: boolean;
  capabilities(): { fullInstall: boolean; atomicActivation: boolean; attachReads: boolean; catalogWrites: boolean; reason: string | null };
  /** Bounded streaming read of the configured manifest; the adapter stops at maxBytes and throws PAYLOAD_TOO_LARGE. */
  fetchManifest(input: { maxBytes: number }, signal?: AbortSignal): Promise<{ text: string; finalUrl: string; requestedUrl: string }>;
  /** Download + zstd decode (bounded) + SHA-256 + staged write. No activation. */
  stage(entry: PackEntry, options: { trustedOrigins: string[]; onProgress: (p: PackInstallProgress) => void; signal?: AbortSignal }): Promise<PackStageResult>;
  /** Read-only SqlDriver over a staged candidate OR the active file. Core runs ALL validation SQL. */
  openForValidation(ref: string): Promise<SqlDriver>;
  /** candidate -> active; existing active -> previous. */
  activate(language: Language, candidateRef: string): Promise<{ activeRef: string; previousRef: string | null }>;
  /** previous -> active. False when there is none. */
  restorePrevious(language: Language): Promise<boolean>;
  discardPrevious(language: Language): Promise<void>;
  discardCandidate(ref: string): Promise<void>;
  /** Disk truth for boot recovery. */
  inspect(language: Language): Promise<PackDiskState>;
  /** Delete active, previous and staging leftovers. */
  remove(language: Language): Promise<void>;
}

export interface CatalogConfig {
  /** `null` = no catalog source configured (install/check report CATALOG_NOT_CONFIGURED). */
  manifestUrl?: string | null;
  trustedOrigins: string[];
}

type Receipt = InstalledCatalog & { activeRef: string | null };
type Journal = {
  version: 2;
  phase: 'staging' | 'prepared' | 'committed' | 'rolling_back' | 'rolled_back' | 'aborted';
  language: Language;
  oldReceipt: Receipt | null;
  candidateRef: string | null;
  targetSha256: string;
  targetVersion: string;
  previousRef: string | null;
  commitAt: string | null;
};

const TERMINAL = new Set(['installed', 'cancelled', 'failed', 'interrupted', 'committed']);
const MAP_PHASE: Record<PackInstallProgress['phase'], CatalogPhase> = {
  downloading: 'downloading', verifying: 'verifying', validating: 'validating', activating: 'activating', installed: 'installed'
};
const OPEN_STATES = "('prepared','activating','validating_active','rolling_back')";

const absent = (language: Language, generation = 0): InstalledCatalog => ({ language, version: null, sha256: null, installedAt: null, schemaVersion: null, generation, status: 'absent' });
const ABSENT_SQL = `UPDATE installed_catalogs SET status = 'absent', version = NULL, sha256 = NULL, installed_at = NULL, schema_version = NULL, active_ref = NULL, generation = generation + 1 WHERE language = ?`;

export class CatalogInstallService {
  private active: { language: Language; controller: AbortController; progress: CatalogProgress } | null = null;
  private readonly config: CatalogConfig;

  constructor(private readonly ctx: ServiceContext, private readonly port: CatalogInstallPort, config?: CatalogConfig) {
    this.config = config ?? { trustedOrigins: [] };
  }

  private get user() {
    return this.ctx.databases.user;
  }

  private get coordinator() {
    return this.ctx.databases.coordinator;
  }

  async installed(language: Language): Promise<Receipt> {
    const rows = await this.user.rows('SELECT version, sha256, installed_at, status, schema_version, generation, active_ref FROM installed_catalogs WHERE language = ?', [language]);
    const r = rows[0];
    if (!r) return { ...absent(language), activeRef: null };
    return {
      language, version: r[0] as string | null, sha256: r[1] as string | null, installedAt: r[2] as string | null, status: r[3] as InstalledCatalog['status'],
      schemaVersion: r[4] === null ? null : Number(r[4]), generation: Number(r[5]), activeRef: r[6] as string | null
    };
  }

  private async publicInstalled(language: Language): Promise<InstalledCatalog> {
    const { activeRef: _ref, ...rest } = await this.installed(language);
    void _ref;
    return rest;
  }

  /* ------------------------------------------------------------------------------------------ manifest */
  private async manifest(signal?: AbortSignal): Promise<CatalogManifest> {
    if (this.config.manifestUrl === null) throw new CatalogError('CATALOG_NOT_CONFIGURED', 'No catalog source is configured in this build');
    let fetched: { text: string; finalUrl: string; requestedUrl: string };
    try {
      fetched = await this.port.fetchManifest({ maxBytes: MANIFEST_MAX_BYTES }, signal);
    } catch (error) {
      if (signal?.aborted) throw new CancelledError();
      const e = toDomainError(error);
      throw new CatalogError(e.code === 'INTERNAL_ERROR' ? 'HTTP_FAILED' : e.code, e.code === 'INTERNAL_ERROR' ? 'The catalog manifest could not be downloaded' : e.message);
    }
    const raw = parseManifestText(fetched.text);
    const installed = [await this.installed('en'), await this.installed('ja')];
    return validateManifestSemantics(raw, {
      requestedUrl: fetched.requestedUrl, finalUrl: fetched.finalUrl, trustedOrigins: this.config.trustedOrigins, allowDevUrls: this.port.allowDevUrls, installed
    });
  }

  async checkManifest(input?: Input<typeof CheckManifestInput>, signal?: AbortSignal): Promise<CatalogUpdateCheck> {
    const parsedInput = parse(CheckManifestInput, input);
    const settings = await this.user.read((q) => readSettings(q));
    const wanted = parsedInput?.languages ?? settings.languages;
    const manifest = await this.manifest(signal);
    const languages: CatalogUpdateCheck['languages'] = [];
    for (const language of wanted) {
      const entry = manifest.languages[language];
      if (!entry) continue;
      const installed = await this.installed(language);
      const compatible = entry.schemaVersion <= CATALOG_SCHEMA_VERSION;
      languages.push({
        language, currentVersion: installed.version, targetVersion: entry.targetVersion, schemaVersion: entry.schemaVersion,
        compressedBytes: entry.compressedBytes, uncompressedBytes: entry.uncompressedBytes, setIndexUrl: entry.setIndexUrl ?? null, counts: entry.counts,
        updateAvailable: compatible && (installed.status !== 'installed' || installed.version !== entry.targetVersion || installed.sha256 !== entry.sha256),
        compatible, reason: compatible ? null : 'APP_UPDATE_REQUIRED', strategy: 'full', fallbackReason: entry.delta ? 'NOT_IMPLEMENTED' : null
      });
    }
    return { manifestVersion: 1, checkedAt: this.ctx.env.clock.now(), languages };
  }

  /* ------------------------------------------------------------------------------------------ status */
  async status(language: Language): Promise<CatalogStatus> {
    const installed = await this.publicInstalled(language);
    const jobs = await this.user.rows(
      'SELECT id, state, progress_json, last_error_json, created_at FROM catalog_install_jobs WHERE language = ? ORDER BY created_at DESC, id DESC LIMIT 1', [language]
    );
    const job = jobs[0];
    let progress: CatalogProgress | null = null;
    let lastError: { code: string; message: string } | null = null;
    if (job) {
      const stored = parseJson<Partial<CatalogProgress>>(String(job[2]), {});
      if (!TERMINAL.has(String(job[1])) || job[1] === 'interrupted') {
        progress = {
          operationId: String(job[0]), language, phase: String(job[1]) as CatalogPhase, compressedBytesDone: stored.compressedBytesDone ?? 0,
          compressedBytesTotal: stored.compressedBytesTotal ?? null, uncompressedBytesDone: stored.uncompressedBytesDone ?? 0,
          uncompressedBytesTotal: stored.uncompressedBytesTotal ?? null, cancellable: this.active?.language === language, elapsedMs: stored.elapsedMs ?? 0,
          warningCode: stored.warningCode ?? null
        };
      }
      if (job[1] === 'failed' || job[1] === 'interrupted' || job[1] === 'cancelled') {
        const err = parseJson<{ code?: string; message?: string } | null>(job[3] as string | null, null);
        lastError = err?.code ? { code: err.code, message: err.message ?? '' } : job[1] === 'cancelled' ? { code: 'CANCELLED', message: 'Cancelled' } : null;
      }
    }
    if (this.active?.language === language) progress = this.active.progress;
    // R06: rollback availability is DISK truth (a retained previous copy), never an in-memory set.
    const rollbackAvailable = await this.port.inspect(language).then((d) => d.previousRef !== null, () => false);
    return { installed, job: progress, lastError, rollbackAvailable, capabilities: this.port.capabilities() };
  }

  /** Cancel the running install, if any. Before activation this leaves the installed state unchanged. */
  cancel(): void {
    this.active?.controller.abort();
  }

  get activeProgress(): CatalogProgress | null {
    return this.active?.progress ?? null;
  }

  /* ------------------------------------------------------------------------------------------ install */
  async install(language: Language, onProgress: (progress: CatalogProgress) => void, signal: AbortSignal): Promise<InstalledCatalog> {
    const operationId = this.ctx.env.ids.uuid();
    const lease = await this.coordinator.admit('install', { languages: [language], token: this.ctx.env.ids.uuid(), now: this.ctx.env.clock.now() });
    try {
      return await this.installAdmitted(lease, operationId, language, onProgress, signal);
    } finally {
      await lease.release();
    }
  }

  private async installAdmitted(lease: WorkLease, operationId: string, language: Language, onProgress: (progress: CatalogProgress) => void, signal: AbortSignal): Promise<InstalledCatalog> {
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forward, { once: true });
    const started = Date.now();
    const progress: CatalogProgress = {
      operationId, language, phase: 'checking', compressedBytesDone: 0, compressedBytesTotal: null, uncompressedBytesDone: 0, uncompressedBytesTotal: null,
      cancellable: true, elapsedMs: 0, warningCode: null
    };
    this.active = { language, controller, progress };
    const emit = (patch: Partial<CatalogProgress>) => {
      Object.assign(progress, patch, { elapsedMs: Date.now() - started });
      try { onProgress({ ...progress }); } catch { /* observer errors never leave the lock held */ }
    };
    let jobCreated = false;
    let candidateRef: string | null = null;
    try {
      emit({});
      const settings = await this.user.read((q) => readSettings(q));
      if (!settings.languages.includes(language)) throw new CatalogError('CATALOG_NOT_SELECTED', `The ${language} catalog is not selected in settings`);
      const manifest = await this.manifest(controller.signal);
      const entry = manifest.languages[language];
      if (!entry) throw new CatalogError('CATALOG_NOT_SELECTED', `The manifest has no ${language} catalog`);
      if (entry.schemaVersion > CATALOG_SCHEMA_VERSION) throw new CatalogError('APP_UPDATE_REQUIRED', 'A newer version of the app is required for this catalog');
      const before = await this.installed(language);
      if (before.status === 'installed' && before.version === entry.targetVersion && before.sha256 === entry.sha256) {
        emit({ phase: 'installed' });
        return await this.publicInstalled(language);
      }

      const now = this.ctx.env.clock.now();
      const journal: Journal = {
        version: 2, phase: 'staging', language, oldReceipt: before.status === 'installed' ? before : null, candidateRef: null,
        targetSha256: entry.sha256, targetVersion: entry.targetVersion, previousRef: null, commitAt: null
      };
      await this.user.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO catalog_install_jobs (id, language, state, lock_key, token, manifest_entry_json, compressed_bytes_done, decompressed_bytes_done, progress_json, journal_json, created_at, updated_at)
           VALUES (?, ?, 'downloading', 'catalog-install', ?, ?, 0, 0, ?, ?, ?, ?)`,
          [operationId, language, lease.token, JSON.stringify(entry), JSON.stringify(progress), JSON.stringify(journal), now, now]
        );
      });
      jobCreated = true;
      emit({ phase: 'downloading', compressedBytesTotal: entry.compressedBytes, uncompressedBytesTotal: entry.uncompressedBytes });

      let lastPersist = 0;
      const staged = await this.port.stage({ ...entry, language }, {
        trustedOrigins: this.config.trustedOrigins,
        signal: controller.signal,
        onProgress: (p) => {
          const phase = MAP_PHASE[p.phase];
          const phaseChanged = phase !== progress.phase;
          emit({ phase: phase === 'installed' ? 'activating' : phase, compressedBytesDone: p.compressedBytesDone, compressedBytesTotal: p.compressedBytesTotal, uncompressedBytesDone: p.decompressedBytesDone, uncompressedBytesTotal: p.decompressedBytesTotal, cancellable: phase === 'downloading' || phase === 'verifying' || phase === 'validating' });
          if (phaseChanged || Date.now() - lastPersist > 500) {
            lastPersist = Date.now();
            void this.saveJob(operationId, progress.phase === 'checking' ? 'downloading' : (progress.phase as string), progress).catch(() => undefined);
          }
        }
      });
      candidateRef = staged.candidateRef;

      // Core re-checks what the adapter claims (R09).
      if (staged.language !== language || staged.version !== entry.targetVersion) throw new CatalogError('PACK_INVALID', 'The staged catalog is not the one that was requested');
      if (staged.bytes !== entry.uncompressedBytes) throw new CatalogError('PACK_SIZE_MISMATCH', 'The decompressed size does not match the manifest');
      if (staged.sha256 !== entry.sha256) throw new CatalogError('PACK_HASH_MISMATCH', 'The decompressed SHA-256 does not match the manifest');

      emit({ phase: 'validating', cancellable: true });
      let driver: SqlDriver | null = null;
      try {
        driver = await this.port.openForValidation(staged.candidateRef);
        await validateCatalogCandidate(driver, { language, targetVersion: entry.targetVersion, counts: entry.counts });
      } finally {
        await driver?.close().catch(() => undefined);
      }
      if (controller.signal.aborted) throw new CancelledError();

      // R06: durable PREPARED journal, committed BEFORE any rename. Everything needed to undo the swap is in it.
      const prepared: Journal = { ...journal, phase: 'prepared', candidateRef: staged.candidateRef };
      emit({ phase: 'activating', cancellable: false });
      await this.user.transaction(async (tx) => {
        await tx.run('UPDATE catalog_install_jobs SET state = ?, journal_json = ?, progress_json = ?, updated_at = ? WHERE id = ?', ['prepared', JSON.stringify(prepared), JSON.stringify(progress), this.ctx.env.clock.now(), operationId]);
      });

      let committedPrevious: string | null = null;
      await lease.withBarrier([language], async () => {
        await this.ctx.databases.invalidateCatalog(language); // release core's read handle right before the swap
        let activated: { activeRef: string; previousRef: string | null };
        try {
          activated = await this.port.activate(language, staged.candidateRef);
        } catch (error) {
          await this.undoSwap(language, prepared);
          throw error;
        }
        emit({ phase: 'validating_active', cancellable: false });
        const commitAt = this.ctx.env.clock.now();
        try {
          await this.user.transaction(async (tx) => {
            await tx.run(
              `UPDATE installed_catalogs SET status = 'installed', version = ?, sha256 = ?, installed_at = ?, schema_version = ?, generation = generation + 1, active_ref = ? WHERE language = ?`,
              [staged.version, staged.sha256, commitAt, entry.schemaVersion, activated.activeRef, language]
            );
            await tx.run('UPDATE catalog_install_jobs SET state = ?, journal_json = ?, progress_json = ?, updated_at = ? WHERE id = ?', [
              'committed', JSON.stringify({ ...prepared, phase: 'committed', previousRef: activated.previousRef, commitAt } satisfies Journal), JSON.stringify(progress), commitAt, operationId
            ]);
          });
        } catch (error) {
          // PERSISTENCE_FAILED: COMMIT happened and durability is unknown. Leave the files alone: boot recovery reconciles either outcome from journal + disk.
          if (!(error instanceof PersistenceError)) await this.undoSwap(language, prepared);
          throw error;
        }
        committedPrevious = activated.previousRef;
        this.ctx.databases.bumpEpoch(language);
        await this.ctx.databases.invalidateCatalog(language);
      });
      candidateRef = null; // consumed
      void committedPrevious;
      await this.port.discardPrevious(language).catch(() => undefined); // cleanup failure never turns a committed install into a failure
      await this.recordMetrics(language, staged, operationId, this.ctx.env.clock.now());
      emit({ phase: 'installed', compressedBytesDone: entry.compressedBytes, uncompressedBytesDone: entry.uncompressedBytes, cancellable: false });
      await this.finishJob(operationId, 'installed', progress, null);
      return await this.publicInstalled(language);
    } catch (error) {
      const domain = controller.signal.aborted && !(error instanceof CatalogError && error.code !== 'CANCELLED') ? new CancelledError() : this.asCatalogError(error);
      if (candidateRef) await this.port.discardCandidate(candidateRef).catch(() => undefined);
      if (jobCreated) {
        const state = domain.code === 'CANCELLED' ? 'cancelled' : 'failed';
        emit({ phase: state, cancellable: false });
        await this.finishJob(operationId, state, progress, { code: domain.code, message: domain.message }).catch(() => undefined);
      } else {
        emit({ phase: domain.code === 'CANCELLED' ? 'cancelled' : 'failed', cancellable: false });
      }
      throw domain;
    } finally {
      signal.removeEventListener('abort', forward);
      this.active = null;
    }
  }

  /**
   * Put the disk back to the pre-swap state using disk truth + the prepared journal. Used after an activate/commit failure and by boot recovery.
   * Never throws: whatever it cannot fix is reconciled again at the next boot.
   */
  private async undoSwap(language: Language, journal: Journal): Promise<void> {
    try {
      const disk = await this.port.inspect(language);
      const candidatePresent = journal.candidateRef !== null && disk.candidateRefs.includes(journal.candidateRef);
      if (candidatePresent) {
        // Activation did not complete. Between the two renames the old active may sit in `previous` with no active file.
        if (disk.activeRef === null && disk.previousRef !== null) await this.port.restorePrevious(language);
        await this.port.discardCandidate(journal.candidateRef as string);
      } else if (journal.oldReceipt) {
        if (disk.previousRef !== null) await this.port.restorePrevious(language);
      } else {
        await this.port.remove(language); // first install: nothing to go back to
      }
    } catch {
      /* boot recovery will retry from the journal */
    }
  }

  private asCatalogError(error: unknown): DomainError {
    if (error instanceof DomainError) return error;
    const e = error as { code?: unknown; message?: unknown } | null;
    if (e && typeof e.code === 'string' && /^[A-Z_]+$/.test(e.code)) {
      const code = e.code === 'ACTIVATION_FAILED' ? 'PACK_INVALID' : e.code;
      return new CatalogError(code, typeof e.message === 'string' ? e.message : 'Catalog install failed');
    }
    return toDomainError(error);
  }

  private async saveJob(id: string, state: string, progress: CatalogProgress): Promise<void> {
    const valid = ['checking', 'downloading', 'downloaded', 'size_checked', 'decompressing', 'verifying', 'validating'];
    if (!valid.includes(state)) return;
    await this.user.run("UPDATE catalog_install_jobs SET state = ?, compressed_bytes_done = ?, decompressed_bytes_done = ?, progress_json = ?, updated_at = ? WHERE id = ? AND lock_key IS NOT NULL AND state NOT IN ('prepared','committed')", [
      state, progress.compressedBytesDone, progress.uncompressedBytesDone, JSON.stringify(progress), this.ctx.env.clock.now(), id
    ]);
  }

  private async finishJob(id: string, state: 'installed' | 'failed' | 'cancelled' | 'interrupted', progress: CatalogProgress | null, error: { code: string; message: string } | null): Promise<void> {
    await this.user.transaction(async (tx) => {
      await tx.run('UPDATE catalog_install_jobs SET state = ?, lock_key = NULL, last_error_json = ?, progress_json = COALESCE(?, progress_json), updated_at = ? WHERE id = ?', [
        state, error ? JSON.stringify(error) : null, progress ? JSON.stringify(progress) : null, this.ctx.env.clock.now(), id
      ]);
    });
  }

  private async recordMetrics(language: Language, result: PackStageResult, operationId: string, at: string): Promise<void> {
    try {
      await this.user.transaction(async (tx) => {
        await tx.run('INSERT INTO pack_metrics (id, language, version, operation_id, metrics_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)', [
          this.ctx.env.ids.uuid(), language, result.version, operationId, JSON.stringify(result.metrics), at
        ]);
        await tx.run('DELETE FROM pack_metrics WHERE id NOT IN (SELECT id FROM pack_metrics ORDER BY recorded_at DESC, id DESC LIMIT 100)');
      });
    } catch {
      /* metrics are diagnostics; never fail an installed catalog */
    }
  }

  /* ------------------------------------------------------------------------------------------ rollback / uninstall */
  async rollback(language: Language): Promise<InstalledCatalog> {
    const lease = await this.coordinator.admit('rollback', { languages: [language], token: this.ctx.env.ids.uuid(), now: this.ctx.env.clock.now() });
    try {
      const disk = await this.port.inspect(language);
      if (disk.previousRef === null) throw new CatalogError('NO_ROLLBACK', 'There is no previous catalog to restore');
      const jobs = await this.user.rows("SELECT id, journal_json FROM catalog_install_jobs WHERE language = ? AND state IN ('committed','installed') ORDER BY created_at DESC, id DESC LIMIT 1", [language]);
      const jobId = jobs[0]?.[0] as string | undefined;
      const journal = parseJson<Journal | null>(jobs[0]?.[1] as string | undefined, null);
      if (!jobId || !journal || !journal.oldReceipt) throw new CatalogError('NO_ROLLBACK', 'There is no previous catalog to restore');
      const old = journal.oldReceipt;
      await this.user.transaction(async (tx) => {
        await tx.run("UPDATE catalog_install_jobs SET state = 'rolling_back', journal_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify({ ...journal, phase: 'rolling_back' }), this.ctx.env.clock.now(), jobId]);
      });
      await lease.withBarrier([language], async () => {
        await this.ctx.databases.invalidateCatalog(language);
        if (!(await this.port.restorePrevious(language))) throw new CatalogError('NO_ROLLBACK', 'There is no previous catalog to restore');
        await this.writeReceipt(language, old, jobId, journal);
        this.ctx.databases.bumpEpoch(language);
        await this.ctx.databases.invalidateCatalog(language);
      });
      return await this.publicInstalled(language);
    } finally {
      await lease.release();
    }
  }

  private async writeReceipt(language: Language, old: Receipt, jobId: string, journal: Journal): Promise<void> {
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      await tx.run(`UPDATE installed_catalogs SET status = 'installed', version = ?, sha256 = ?, installed_at = ?, schema_version = ?, generation = generation + 1, active_ref = ? WHERE language = ?`, [
        old.version, old.sha256, old.installedAt ?? now, old.schemaVersion, old.activeRef ?? 'restored', language
      ]);
      await tx.run("UPDATE catalog_install_jobs SET state = 'committed', journal_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify({ ...journal, phase: 'rolled_back' }), now, jobId]);
    });
  }

  async uninstall(input: Input<typeof UninstallInput>): Promise<InstalledCatalog> {
    const { language } = parse(UninstallInput, input);
    const lease = await this.coordinator.admit('uninstall', { languages: [language], token: this.ctx.env.ids.uuid(), now: this.ctx.env.clock.now() });
    try {
      const current = await this.installed(language);
      const disk = await this.port.inspect(language).catch(() => ({ activeRef: null, previousRef: null, candidateRefs: [] }) as PackDiskState);
      if (current.status === 'absent' && disk.activeRef === null && disk.previousRef === null && disk.candidateRefs.length === 0) return this.publicInstalled(language);
      await lease.withBarrier([language], async () => {
        await this.ctx.databases.invalidateCatalog(language);
        try {
          await this.port.remove(language);
        } catch (error) {
          const e = toDomainError(error);
          throw new CatalogError('FILE_IO', e.code === 'INTERNAL_ERROR' ? 'The catalog files could not be removed' : e.message); // row untouched: prior state kept
        }
        await this.user.transaction(async (tx) => { await tx.run(ABSENT_SQL, [language]); }); // personal rows, history, annotations and settings are never touched
        this.ctx.databases.bumpEpoch(language);
        await this.ctx.databases.invalidateCatalog(language);
      });
      return await this.publicInstalled(language);
    } finally {
      await lease.release();
    }
  }

  /* ------------------------------------------------------------------------------------------ boot recovery (R06) */
  /**
   * Boot recovery (app start, before any catalog open). Reconciles the committed receipt + journals with what is actually on disk
   * (`port.inspect`), validates the active file cheaply (schema + catalog_meta vs receipt; no full rehash) and cleans stray files.
   * Never creates an empty catalog and never trusts in-memory state.
   */
  async recover(): Promise<{ interruptedJobs: number; reconciled: Language[]; actions: string[] }> {
    const actions: string[] = [];
    await this.coordinator.reconcile().catch(() => false);
    const reconciled: Language[] = [];
    const touched = new Set<Language>();

    for (const language of ['en', 'ja'] as const) {
      try {
        const changed = await this.recoverLanguage(language, actions);
        if (changed) { reconciled.push(language); touched.add(language); }
      } catch {
        actions.push(`${language}:recovery-error`); // retried next boot; startup is never blocked by one bad language
      }
    }

    const now = this.ctx.env.clock.now();
    const stuck = await this.user.rows(`SELECT id FROM catalog_install_jobs WHERE state NOT IN ('installed','cancelled','failed','interrupted','committed') OR lock_key IS NOT NULL`);
    for (const row of stuck) {
      await this.user.transaction(async (tx) => {
        await tx.run(
          `UPDATE catalog_install_jobs SET state = CASE WHEN state IN ('committed','installed') THEN state ELSE 'interrupted' END, lock_key = NULL,
             last_error_json = COALESCE(last_error_json, ?), updated_at = ? WHERE id = ?`,
          [JSON.stringify({ code: 'INTERRUPTED', message: 'The download was interrupted. Start it again.' }), now, String(row[0])]
        );
      });
    }
    for (const language of touched) {
      this.ctx.databases.bumpEpoch(language);
      await this.ctx.databases.invalidateCatalog(language).catch(() => undefined);
    }
    return { interruptedJobs: stuck.length, reconciled, actions };
  }

  private async latestJob(language: Language, whereStates: string): Promise<{ id: string; state: string; journal: Journal | null } | null> {
    const rows = await this.user.rows(`SELECT id, state, journal_json FROM catalog_install_jobs WHERE language = ? AND state IN ${whereStates} ORDER BY created_at DESC, id DESC LIMIT 1`, [language]);
    const r = rows[0];
    if (!r) return null;
    const journal = parseJson<Journal | null>(String(r[2]), null);
    return { id: String(r[0]), state: String(r[1]), journal: journal && journal.version === 2 ? journal : null };
  }

  /** Returns true when the receipt or the files were changed. */
  private async recoverLanguage(language: Language, actions: string[]): Promise<boolean> {
    let changed = false;
    let disk = await this.port.inspect(language);
    const act = (what: string) => { actions.push(`${language}:${what}`); changed = true; };

    // 1. A swap that was prepared (journal committed) but whose receipt never committed, or a rollback that was in flight.
    const open = await this.latestJob(language, OPEN_STATES);
    if (open?.journal) {
      const j = open.journal;
      if (open.state === 'rolling_back') {
        if (disk.previousRef === null && j.oldReceipt) {
          await this.writeReceipt(language, j.oldReceipt, open.id, j); // the swap finished, only the receipt is missing
          act('rollback-completed');
        } else {
          act('rollback-abandoned');
        }
      } else if (j.phase === 'prepared' || open.state === 'prepared' || open.state === 'activating' || open.state === 'validating_active') {
        await this.undoSwap(language, j);
        act(j.oldReceipt ? 'restored-previous' : 'removed-uncommitted-first-install');
      }
      disk = await this.port.inspect(language);
    }

    // 2. Committed receipt + a previous copy still on disk: the commit is durable, finish the cleanup.
    const receipt = await this.installed(language);
    if (receipt.status === 'installed' && disk.activeRef !== null && disk.previousRef !== null) {
      await this.port.discardPrevious(language);
      act('discarded-previous');
    }
    // 3. Stray staging candidates (no install is running at boot).
    for (const ref of disk.candidateRefs) {
      await this.port.discardCandidate(ref);
      act('discarded-candidate');
    }
    disk = await this.port.inspect(language);

    // 4. Receipt vs disk.
    if (receipt.status === 'installed') {
      if (disk.activeRef === null) {
        if (disk.previousRef !== null && (await this.port.restorePrevious(language))) {
          act('restored-previous-as-active');
          disk = await this.port.inspect(language);
        } else {
          await this.user.transaction(async (tx) => { await tx.run(ABSENT_SQL, [language]); });
          act('receipt-cleared-no-file');
          return changed;
        }
      }
      if (!(await this.activeMatchesReceipt(language, receipt, disk))) {
        await this.user.transaction(async (tx) => { await tx.run("UPDATE installed_catalogs SET status = 'failed', generation = generation + 1 WHERE language = ?", [language]); });
        act('receipt-marked-failed');
      }
    } else if (receipt.status === 'absent' && disk.activeRef !== null) {
      await this.port.remove(language).catch(() => undefined); // uncommitted file left behind
      act('removed-unreceipted-active');
    }
    return changed;
  }

  /** Cheap check (R06): schema + catalog_meta vs receipt, and the receipt's sha vs the sha the committed install job recorded. */
  private async activeMatchesReceipt(language: Language, receipt: Receipt, disk: PackDiskState): Promise<boolean> {
    if (disk.activeRef === null || !receipt.version) return false;
    let driver: SqlDriver | null = null;
    try {
      driver = await this.port.openForValidation(disk.activeRef);
      await validateActiveCatalog(driver, { language, version: receipt.version });
    } catch {
      return false;
    } finally {
      await driver?.close().catch(() => undefined);
    }
    const job = await this.latestJob(language, "('committed','installed')");
    if (job?.journal && job.journal.targetVersion === receipt.version && job.journal.phase === 'committed' && receipt.sha256 !== null && job.journal.targetSha256 !== receipt.sha256) return false;
    return true;
  }
}
