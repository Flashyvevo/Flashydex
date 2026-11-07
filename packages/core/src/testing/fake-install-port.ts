import Database from 'better-sqlite3';
import { copyFileSync, existsSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Language } from '@flashydex/schemas';
import { CATALOG_CHAIN_FINGERPRINT } from '../services/candidate-validation';
import type { SqlDriver } from '../db/sql';
import type { Environment } from '../platform/platform';
import type { CatalogInstallPort, PackDiskState, PackEntry, PackInstallProgress, PackStageResult } from '../services/catalog-install';
import { seedCatalog } from './catalog-fixture';
import { createCatalogFile, createNodeDriver } from './node-driver';

/** Thrown by a fault hook to simulate the process being killed at that point. */
export class KillSignal extends Error {
  constructor(where: string) {
    super(`killed at ${where}`);
  }
}

export type FakePortHook =
  | 'stage:start' | 'stage:end' | 'activate:start' | 'activate:between' | 'activate:put' | 'activate:end' | 'restore:start' | 'restore:end' | 'discardPrevious' | 'discardCandidate' | 'remove';

/** Counts of the synthetic catalog `stage()` writes (1 set, 5 cards, no variant rows). TESTS ONLY. */
export const FAKE_PACK_COUNTS = { sets: 1, cards: 5, variants: 0, prices: 0, unpublishedSets: 0 };

/**
 * Fake CatalogInstallPort v2 over REAL files in a directory: active `catalog-<lang>.db` (what DirectoryCatalogSource opens), a
 * `.previous` sibling, and `candidate-*` staging files. `hooks` may throw KillSignal; the port is then `dead` (every call throws,
 * like a killed process) until `revive()`, so cleanup code cannot accidentally heal a simulated crash. TESTS ONLY.
 */
export class FakeDiskPort implements CatalogInstallPort {
  allowDevUrls = false;
  manifestJson: unknown = null;
  manifestError: (Error & { code?: string }) | null = null;
  stageError: (Error & { code?: string }) | null = null;
  activateError: (Error & { code?: string }) | null = null;
  /** `between`: fail after active->previous but before candidate->active. */
  activateErrorAt: 'start' | 'between' = 'start';
  hold: Promise<void> | null = null;
  calls: string[] = [];
  hooks: Partial<Record<FakePortHook, () => void | Promise<void>>> = {};
  /** Mutate the staged candidate with raw SQLite before it is closed (candidate-validation tests). */
  corrupt: ((db: Database.Database) => void) | null = null;
  /** Override catalog_meta values written to a candidate. */
  metaOverride: Partial<{ language: string; version: string; schemaVersion: number }> = {};
  dead = false;
  /**
   * `rename` (native): active->previous and candidate->active are renames; the candidate is consumed.
   * `web` (IndexedDB key writes, apps/mobile web-store.ts): previous = COPY of active, active = COPY of candidate (a put), THEN the candidate
   * key is removed. Between the active put and the candidate removal (`activate:put` hook) active + previous + candidate all exist.
   */
  style: 'rename' | 'web' = 'rename';
  private counter = 0;

  constructor(private readonly dir: string, private readonly env: Environment, readonly requestedUrl = 'https://example.test/manifest.json') {}

  revive(): void {
    this.dead = false;
  }

  activePath(language: Language): string {
    return join(this.dir, `catalog-${language}.db`);
  }
  previousPath(language: Language): string {
    return `${this.activePath(language)}.previous`;
  }
  private candidatePath(ref: string): string {
    return join(this.dir, ref.replace(/^cand:/, ''));
  }
  private pathOf(ref: string): string {
    if (ref.startsWith('active:')) return this.activePath(ref.slice(7) as Language);
    if (ref.startsWith('previous:')) return this.previousPath(ref.slice(9) as Language);
    return this.candidatePath(ref);
  }

  private alive(): void {
    if (this.dead) throw new Error('process is dead');
  }
  private async hook(name: FakePortHook): Promise<void> {
    const fn = this.hooks[name];
    if (!fn) return;
    try {
      await fn();
    } catch (error) {
      if (error instanceof KillSignal) this.dead = true;
      throw error;
    }
  }

  capabilities() {
    return { fullInstall: true, atomicActivation: true, attachReads: false, catalogWrites: true, reason: null };
  }

  async fetchManifest(): Promise<{ text: string; finalUrl: string; requestedUrl: string }> {
    this.alive();
    if (this.manifestError) throw this.manifestError;
    return { text: typeof this.manifestJson === 'string' ? this.manifestJson : JSON.stringify(this.manifestJson), finalUrl: this.requestedUrl, requestedUrl: this.requestedUrl };
  }

  async stage(entry: PackEntry, options: { trustedOrigins: string[]; onProgress: (p: PackInstallProgress) => void; signal?: AbortSignal }): Promise<PackStageResult> {
    this.alive();
    this.calls.push(`stage:${entry.language}:${entry.targetVersion}`);
    await this.hook('stage:start');
    options.onProgress({ phase: 'downloading', compressedBytesDone: 10, compressedBytesTotal: entry.compressedBytes, decompressedBytesDone: 0, decompressedBytesTotal: entry.uncompressedBytes });
    if (this.hold) {
      await new Promise<void>((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' })), { once: true });
        void this.hold!.then(resolve);
      });
    }
    if (this.stageError) throw this.stageError;
    this.counter += 1;
    const file = `candidate-${this.counter}-${entry.language}.db`;
    const path = join(this.dir, file);
    rmSync(path, { force: true });
    const writer = await createCatalogFile(path, entry.language, this.env);
    await seedCatalog(writer, entry.language, {
      sets: [{ id: 'tset', name: 'Test Set Alpha', series: 'tseries', releaseDate: '2020-02-07' }],
      cards: ['001', '002', '003', '004', '005'].map((localId, i) => ({
        id: `tset-${localId}`, setId: 'tset', localId, name: `${entry.targetVersion} ${['Alpha Mon', 'Beta Mon', 'Gamma Mon', 'Delta Mon', 'Alpha Beast'][i]}`,
        rarity: 'Common', variants: i === 0 ? (['normal', 'reverse_holo', 'holo'] as const).slice() : ['normal']
      }))
    });
    const m = this.metaOverride;
    await writer.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO catalog_meta (id, language, version, schema_version, built_at, builder_version, source_cutoff_at, source_set_count, source_card_count, source_variant_count,
           source_price_count, unpublished_set_count, schema_fingerprint) VALUES ('catalog', ?, ?, ?, ?, 'test', ?, 1, 5, 0, 0, 0, ?)`,
        [m.language ?? entry.language, m.version ?? entry.targetVersion, m.schemaVersion ?? 1, '2026-10-31T01:00:00.000Z', '2026-10-31T00:00:00.000Z', CATALOG_CHAIN_FINGERPRINT]
      );
    });
    await writer.close();
    if (this.corrupt) {
      const raw = new Database(path);
      try { this.corrupt(raw); } finally { raw.close(); }
    }
    options.onProgress({ phase: 'verifying', compressedBytesDone: entry.compressedBytes, compressedBytesTotal: entry.compressedBytes, decompressedBytesDone: entry.uncompressedBytes, decompressedBytesTotal: entry.uncompressedBytes });
    await this.hook('stage:end');
    return { language: entry.language, version: entry.targetVersion, sha256: entry.sha256, bytes: entry.uncompressedBytes, candidateRef: `cand:${file}`, metrics: { metricsVersion: 2, totalMs: 12, pendingBytesMax: 0 } };
  }

  async openForValidation(ref: string): Promise<SqlDriver> {
    this.alive();
    const path = this.pathOf(ref);
    if (!existsSync(path)) throw new Error('missing file');
    return createNodeDriver(path, { readonly: true, label: `validate-${ref}` });
  }

  async activate(language: Language, candidateRef: string): Promise<{ activeRef: string; previousRef: string | null }> {
    this.alive();
    this.calls.push(`activate:${language}`);
    await this.hook('activate:start');
    if (this.activateError && this.activateErrorAt === 'start') throw this.activateError;
    const active = this.activePath(language);
    const previous = this.previousPath(language);
    const had = existsSync(active);
    if (this.style === 'web') {
      if (had) {
        rmSync(previous, { force: true });
        copyFileSync(active, previous);
      }
      await this.hook('activate:between');
      if (this.activateError && this.activateErrorAt === 'between') throw this.activateError;
      copyFileSync(this.candidatePath(candidateRef), active);
      await this.hook('activate:put');
      rmSync(this.candidatePath(candidateRef), { force: true });
      await this.hook('activate:end');
      return { activeRef: `active:${language}`, previousRef: had ? `previous:${language}` : null };
    }
    if (had) {
      rmSync(previous, { force: true });
      renameSync(active, previous);
    }
    await this.hook('activate:between');
    if (this.activateError && this.activateErrorAt === 'between') throw this.activateError;
    renameSync(this.candidatePath(candidateRef), active);
    await this.hook('activate:end');
    return { activeRef: `active:${language}`, previousRef: had ? `previous:${language}` : null };
  }

  async restorePrevious(language: Language): Promise<boolean> {
    this.alive();
    this.calls.push(`restorePrevious:${language}`);
    await this.hook('restore:start');
    const previous = this.previousPath(language);
    if (!existsSync(previous)) return false;
    if (this.style === 'web') {
      copyFileSync(previous, this.activePath(language)); // put active, THEN remove the previous key
      rmSync(previous, { force: true });
    } else {
      rmSync(this.activePath(language), { force: true });
      renameSync(previous, this.activePath(language));
    }
    await this.hook('restore:end');
    return true;
  }

  async discardPrevious(language: Language): Promise<void> {
    this.alive();
    this.calls.push(`discardPrevious:${language}`);
    await this.hook('discardPrevious');
    rmSync(this.previousPath(language), { force: true });
  }

  async discardCandidate(ref: string): Promise<void> {
    this.alive();
    this.calls.push('discardCandidate');
    await this.hook('discardCandidate');
    rmSync(this.candidatePath(ref), { force: true });
  }

  async inspect(language: Language): Promise<PackDiskState> {
    this.alive();
    const candidates = readdirSync(this.dir).filter((f) => f.startsWith('candidate-') && f.endsWith(`-${language}.db`)).map((f) => `cand:${f}`);
    return {
      activeRef: existsSync(this.activePath(language)) ? `active:${language}` : null,
      previousRef: existsSync(this.previousPath(language)) ? `previous:${language}` : null,
      candidateRefs: candidates
    };
  }

  async remove(language: Language): Promise<void> {
    this.alive();
    this.calls.push(`remove:${language}`);
    await this.hook('remove');
    rmSync(this.activePath(language), { force: true });
    rmSync(this.previousPath(language), { force: true });
    for (const f of readdirSync(this.dir)) if (f.startsWith('candidate-') && f.endsWith(`-${language}.db`)) rmSync(join(this.dir, f), { force: true });
  }

  /** Manifest JSON for the synthetic pack (TESTS ONLY). */
  static manifest(languages: Array<'en' | 'ja'>, version = '2026.10.31.001', sha = 'a'.repeat(64), origin = 'https://example.test'): Record<string, unknown> {
    const entry = (language: 'en' | 'ja') => ({
      currentVersion: null, targetVersion: version, fullPackUrl: `${origin}/catalog-${language}-${version}.db.zst`, setIndexUrl: `${origin}/set-index-${language}.json`,
      compressedBytes: 1000, uncompressedBytes: 5000, sha256: sha, schemaVersion: 1, builtAt: '2026-10-31T01:00:00.000Z',
      counts: { ...FAKE_PACK_COUNTS }
    });
    return { manifestVersion: 1, currentVersion: null, targetVersion: version, builtAt: '2026-10-31T01:00:00.000Z', languages: Object.fromEntries(languages.map((l) => [l, entry(l)])) };
  }
}
