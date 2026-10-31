import {
  CheckManifestInput, UninstallInput, createCatalogManifestSchema, type CatalogManifest, type CatalogManifestEntryV1, type CatalogPhase, type CatalogProgress,
  type CatalogStatus, type CatalogUpdateCheck, type InstalledCatalog, type Input
} from '@flashydex/schemas';
import { CATALOG_SCHEMA_VERSION } from '../db/catalog-schema';
import { ActiveWorkError, CancelledError, CatalogError, DomainError, toDomainError } from '../errors';
import { parse, parseJson, readSettings, type ServiceContext } from './context';

type Language = 'en' | 'ja';
export type PackEntry = CatalogManifestEntryV1 & { language: Language };

/** Result of the device pack installer (apps/mobile/src/platform/pack-install `installCatalogPack`). */
export interface PackInstallResult {
  language: Language;
  version: string;
  sha256: string;
  bytes: number;
  /** Opaque active-file reference; never shown or exported. */
  ref: string;
  previousRef: string | null;
  counts: { sets: number; cards: number; variants: number; prices: number; unpublishedSets: number };
  metrics: unknown;
}

export interface PackInstallProgress {
  phase: 'downloading' | 'verifying' | 'validating' | 'activating' | 'installed';
  compressedBytesDone: number;
  compressedBytesTotal: number;
  decompressedBytesDone: number;
  decompressedBytesTotal: number;
}

/** Platform port: the only way core touches pack files. Core stays free of Capacitor/DOM/Node. */
export interface CatalogInstallPort {
  readonly allowDevUrls: boolean;
  capabilities(): { fullInstall: boolean; atomicActivation: boolean; attachReads: boolean; reason: string | null };
  /** Raw manifest JSON from the configured manifest URL. Bounded + fetched by the adapter. */
  fetchManifest(signal?: AbortSignal): Promise<unknown>;
  install(entry: PackEntry, options: { onProgress: (p: PackInstallProgress) => void; signal?: AbortSignal }): Promise<PackInstallResult>;
  /** Discard the retained previous copy (after the durable commit). */
  finalize(language: Language): Promise<void>;
  /** Put the previous copy back as active. False when there is none. */
  rollback(language: Language): Promise<boolean>;
  hasPrevious(language: Language): Promise<boolean>;
  /** Delete the active catalog, previous copy and staging leftovers. */
  remove(language: Language): Promise<void>;
  /** Opaque ref of the active file or null. */
  activeRef(language: Language): Promise<string | null>;
}

const TERMINAL = new Set(['installed', 'cancelled', 'failed', 'interrupted', 'committed']);
const MAP_PHASE: Record<PackInstallProgress['phase'], CatalogPhase> = {
  downloading: 'downloading', verifying: 'verifying', validating: 'validating', activating: 'activating', installed: 'installed'
};

const absent = (language: Language, generation = 0): InstalledCatalog => ({ language, version: null, sha256: null, installedAt: null, schemaVersion: null, generation, status: 'absent' });

export class CatalogInstallService {
  private active: { language: Language; controller: AbortController; progress: CatalogProgress } | null = null;

  constructor(private readonly ctx: ServiceContext, private readonly port: CatalogInstallPort) {}

  private get user() {
    return this.ctx.databases.user;
  }

  async installed(language: Language): Promise<InstalledCatalog & { activeRef: string | null }> {
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
    let raw: unknown;
    try {
      raw = await this.port.fetchManifest(signal);
    } catch (error) {
      if (signal?.aborted) throw new CancelledError();
      const e = toDomainError(error);
      throw new CatalogError(e.code === 'INTERNAL_ERROR' ? 'HTTP_FAILED' : e.code, e.code === 'INTERNAL_ERROR' ? 'The catalog manifest could not be downloaded' : e.message);
    }
    const parsed = createCatalogManifestSchema({ allowDevUrls: this.port.allowDevUrls }).safeParse(raw);
    if (!parsed.success) throw new CatalogError('MANIFEST_INVALID', 'The catalog manifest is not valid');
    return parsed.data;
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
    return { installed, job: progress, lastError, rollbackAvailable: await this.port.hasPrevious(language).catch(() => false), capabilities: this.port.capabilities() };
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
    if (this.active) throw new ActiveWorkError('ACTIVE_WORK', 'A catalog download is already running');
    const settings = await this.user.read((q) => readSettings(q));
    if (!settings.languages.includes(language)) throw new CatalogError('CATALOG_NOT_SELECTED', `The ${language} catalog is not selected in settings`);

    const operationId = this.ctx.env.ids.uuid();
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
    try {
      emit({});
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
      const journal = { version: 1, oldInstalled: before.status === 'installed' ? before : null, oldClosedSha256: null, compressedRef: null, candidateRef: null, previousRef: null, targetSha256: entry.sha256, targetBytes: entry.uncompressedBytes, preparedAt: null, commitAt: null };
      try {
        await this.user.transaction(async (tx) => {
          await tx.run(
            `INSERT INTO catalog_install_jobs (id, language, state, lock_key, token, manifest_entry_json, compressed_bytes_done, decompressed_bytes_done, progress_json, journal_json, created_at, updated_at)
             VALUES (?, ?, 'downloading', 'catalog-install', ?, ?, 0, 0, ?, ?, ?, ?)`,
            [operationId, language, this.ctx.env.ids.uuid(), JSON.stringify(entry), JSON.stringify(progress), JSON.stringify(journal), now, now]
          );
        });
      } catch {
        throw new ActiveWorkError('ACTIVE_WORK', 'A catalog download is already running');
      }
      jobCreated = true;
      emit({ phase: 'downloading', compressedBytesTotal: entry.compressedBytes, uncompressedBytesTotal: entry.uncompressedBytes });

      await this.ctx.databases.invalidateCatalog(language); // release core's read handle before the file swap
      let lastPersist = 0;
      let result: PackInstallResult;
      try {
        result = await this.port.install({ ...entry, language }, {
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
      } catch (error) {
        await this.ctx.databases.invalidateCatalog(language).catch(() => undefined);
        throw error;
      }

      // Activation succeeded on disk. The durable receipt is the commit point; failure restores the previous catalog.
      emit({ phase: 'validating_active', cancellable: false });
      const commitAt = this.ctx.env.clock.now();
      try {
        await this.user.transaction(async (tx) => {
          await tx.run(
            `UPDATE installed_catalogs SET status = 'installed', version = ?, sha256 = ?, installed_at = ?, schema_version = ?, generation = generation + 1, active_ref = ? WHERE language = ?`,
            [result.version, result.sha256, commitAt, entry.schemaVersion, result.ref, language]
          );
          await tx.run(
            `UPDATE catalog_install_jobs SET state = 'committed', journal_json = ?, progress_json = ?, updated_at = ? WHERE id = ?`,
            [JSON.stringify({ ...journal, previousRef: result.previousRef, commitAt }), JSON.stringify(progress), commitAt, operationId]
          );
        });
      } catch (error) {
        await this.port.rollback(language).catch(() => undefined);
        throw error;
      }
      await this.ctx.databases.invalidateCatalog(language);
      await this.port.finalize(language).catch(() => undefined); // cleanup failure never turns a committed install into a failure
      await this.recordMetrics(language, result, operationId, commitAt);
      emit({ phase: 'installed', compressedBytesDone: entry.compressedBytes, uncompressedBytesDone: entry.uncompressedBytes, cancellable: false });
      await this.finishJob(operationId, 'installed', progress, null);
      return await this.publicInstalled(language);
    } catch (error) {
      const domain = controller.signal.aborted && !(error instanceof CatalogError && error.code !== 'CANCELLED') ? new CancelledError() : this.asCatalogError(error);
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
    const valid = ['checking', 'downloading', 'downloaded', 'size_checked', 'decompressing', 'verifying', 'validating', 'prepared', 'activating', 'validating_active'];
    if (!valid.includes(state)) return;
    await this.user.run('UPDATE catalog_install_jobs SET state = ?, compressed_bytes_done = ?, decompressed_bytes_done = ?, progress_json = ?, updated_at = ? WHERE id = ? AND lock_key IS NOT NULL', [
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

  private async recordMetrics(language: Language, result: PackInstallResult, operationId: string, at: string): Promise<void> {
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

  /* ------------------------------------------------------------------------------------------ rollback / uninstall / recovery */
  async rollback(language: Language): Promise<InstalledCatalog> {
    if (this.active) throw new ActiveWorkError('ACTIVE_WORK', 'A catalog download is running');
    if (!(await this.port.hasPrevious(language))) throw new CatalogError('NO_ROLLBACK', 'There is no previous catalog to restore');
    const jobs = await this.user.rows("SELECT journal_json FROM catalog_install_jobs WHERE language = ? AND state IN ('committed','installed') ORDER BY created_at DESC, id DESC LIMIT 1", [language]);
    const journal = parseJson<{ oldInstalled: (InstalledCatalog & { activeRef: string | null }) | null; previousRef: string | null } | null>(jobs[0]?.[0] as string | undefined, null);
    await this.ctx.databases.invalidateCatalog(language);
    if (!(await this.port.rollback(language))) throw new CatalogError('NO_ROLLBACK', 'There is no previous catalog to restore');
    const now = this.ctx.env.clock.now();
    const old = journal?.oldInstalled ?? null;
    await this.user.transaction(async (tx) => {
      if (old && old.version && old.sha256 && old.schemaVersion) {
        await tx.run(`UPDATE installed_catalogs SET status = 'installed', version = ?, sha256 = ?, installed_at = ?, schema_version = ?, generation = generation + 1, active_ref = ? WHERE language = ?`, [
          old.version, old.sha256, old.installedAt ?? now, old.schemaVersion, journal?.previousRef ?? old.activeRef ?? 'restored', language
        ]);
      } else {
        await tx.run(`UPDATE installed_catalogs SET status = 'absent', version = NULL, sha256 = NULL, installed_at = NULL, schema_version = NULL, active_ref = NULL, generation = generation + 1 WHERE language = ?`, [language]);
      }
    });
    await this.ctx.databases.invalidateCatalog(language);
    return this.publicInstalled(language);
  }

  async uninstall(input: Input<typeof UninstallInput>): Promise<InstalledCatalog> {
    const { language } = parse(UninstallInput, input);
    if (this.active) throw new ActiveWorkError('ACTIVE_WORK', 'A catalog download is running');
    const current = await this.installed(language);
    if (current.status === 'absent' && (await this.port.activeRef(language)) === null) return this.publicInstalled(language);
    await this.ctx.databases.invalidateCatalog(language);
    try {
      await this.port.remove(language);
    } catch (error) {
      const e = toDomainError(error);
      throw new CatalogError('FILE_IO', e.code === 'INTERNAL_ERROR' ? 'The catalog files could not be removed' : e.message); // row untouched: prior state kept
    }
    await this.user.transaction(async (tx) => {
      await tx.run(`UPDATE installed_catalogs SET status = 'absent', version = NULL, sha256 = NULL, installed_at = NULL, schema_version = NULL, active_ref = NULL, generation = generation + 1 WHERE language = ?`, [language]);
    }); // personal rows, history, annotations and settings are never touched
    return this.publicInstalled(language);
  }

  /**
   * Boot recovery (app start, before any catalog open): interrupted jobs are marked, and the installed receipt is reconciled with
   * what is actually on disk. Never creates an empty catalog.
   */
  async recover(): Promise<{ interruptedJobs: number; reconciled: Language[] }> {
    const now = this.ctx.env.clock.now();
    const stuck = await this.user.rows("SELECT id FROM catalog_install_jobs WHERE state NOT IN ('installed','cancelled','failed','interrupted','committed') OR lock_key IS NOT NULL");
    for (const row of stuck) {
      await this.user.transaction(async (tx) => {
        await tx.run(
          `UPDATE catalog_install_jobs SET state = CASE WHEN state IN ('committed','installed') THEN state ELSE 'interrupted' END, lock_key = NULL,
             last_error_json = COALESCE(last_error_json, ?), updated_at = ? WHERE id = ?`,
          [JSON.stringify({ code: 'INTERRUPTED', message: 'The download was interrupted. Start it again.' }), now, String(row[0])]
        );
      });
    }
    const reconciled: Language[] = [];
    for (const language of ['en', 'ja'] as const) {
      const row = await this.installed(language);
      const activeRef = await this.port.activeRef(language).catch(() => null);
      if (row.status === 'installed' && activeRef === null) {
        await this.user.transaction(async (tx) => {
          await tx.run(`UPDATE installed_catalogs SET status = 'absent', version = NULL, sha256 = NULL, installed_at = NULL, schema_version = NULL, active_ref = NULL, generation = generation + 1 WHERE language = ?`, [language]);
        });
        reconciled.push(language);
      } else if (row.status === 'absent' && activeRef !== null) {
        await this.port.remove(language).catch(() => undefined); // uncommitted candidate left behind by an interrupted activation
        reconciled.push(language);
      }
    }
    return { interruptedJobs: stuck.length, reconciled };
  }
}
