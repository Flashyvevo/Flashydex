import type { Language } from '@flashydex/schemas';
import { CatalogError, MaintenanceError } from '../errors';
import { Db, type SqlDriver } from './sql';
import { WorkCoordinator } from './coordinator';
import { timed } from '../perf';

/** Opens (read-only) catalog connections. `null` = no catalog installed for that language (a normal state). */
export interface CatalogSource {
  open(language: Language): Promise<SqlDriver | null>;
  /**
   * True when this platform can write catalog files (prices_only / refresh / incremental). D44: function presence no longer counts;
   * a source that declares `writable:true` MUST implement `openWritable`.
   */
  readonly writable: boolean;
  /**
   * A READ-WRITE handle to the installed catalog, used only by SyncService to write `catalog_latest_prices` / catalog rows.
   * The read-only handle is retired before this opens and reopened after (see `DatabaseSet.withWritableCatalog`).
   */
  openWritable?(language: Language): Promise<SqlDriver | null>;
  /** Called when a catalog handle is retired (install / uninstall / rollback). */
  release?(language: Language): Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The user DB plus 0..2 catalog DBs. One connection per file, no ATTACH: repositories do app-level joins (CATALOG-PACKS join plans).
 *
 *  - `generation(language)` increases whenever a catalog handle is replaced (any invalidate).
 *  - `epoch(language)` increases only when catalog CONTENT identity changes (install/uninstall/rollback commit). Generation fencing
 *    (sync batches) and consistent multi-domain reads use the epoch, so a sync's own handle swaps never fence itself out.
 *  - A per-language maintenance barrier: while held, `catalog(language)` waits (bounded) and then throws MAINTENANCE; it never reopens.
 */
export class DatabaseSet {
  private readonly catalogs = new Map<Language, Promise<Db | null>>();
  private readonly generations: Record<Language, number> = { en: 0, ja: 0 };
  private readonly epochs: Record<Language, number> = { en: 0, ja: 0 };
  private readonly barriers = new Map<Language, { done: Promise<void> }>();
  private readonly barrierTail = new Map<Language, Promise<unknown>>();
  readonly coordinator: WorkCoordinator;
  /** How long readers wait for a barrier before MAINTENANCE (ms). */
  barrierWaitMs = 3000;

  constructor(readonly user: Db, private readonly source: CatalogSource) {
    this.coordinator = new WorkCoordinator(this);
  }

  generation(language: Language): number {
    return this.generations[language];
  }

  epoch(language: Language): number {
    return this.epochs[language];
  }

  bumpEpoch(language: Language): void {
    this.epochs[language] += 1;
  }

  barrierHeld(language: Language): boolean {
    return this.barriers.has(language);
  }

  /** Run `fn` with the language barrier(s) held (serialized per language, ordered en<ja so two holders cannot deadlock). */
  async withBarrier<T>(languages: readonly Language[], fn: () => Promise<T>, options: { announce?: boolean } = {}): Promise<T> {
    const ordered = [...new Set(languages)].sort() as Language[];
    const acquire = async (index: number): Promise<T> => {
      const language = ordered[index];
      if (language === undefined) return fn();
      const previous = this.barrierTail.get(language) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => { release = resolve; });
      this.barrierTail.set(language, previous.then(() => mine));
      await previous;
      let open!: () => void;
      const done = new Promise<void>((resolve) => { open = resolve; });
      this.barriers.set(language, { done });
      // E1: install / rollback / uninstall activations are reported through storage.status().maintenance (informational; personal writes continue).
      const endAnnounce = options.announce ? this.user.beginCatalogActivation(language) : null;
      try {
        return await acquire(index + 1);
      } finally {
        endAnnounce?.();
        this.barriers.delete(language);
        open();
        release();
      }
    };
    return acquire(0);
  }

  private async waitBarrier(language: Language): Promise<void> {
    const barrier = this.barriers.get(language);
    if (!barrier) return;
    await Promise.race([barrier.done, wait(this.barrierWaitMs)]);
    if (this.barriers.has(language)) throw new MaintenanceError();
  }

  /** Read-only catalog handle, or null when that language is not installed. Never creates a database; never reopens while a barrier is held. */
  async catalog(language: Language): Promise<Db | null> {
    await this.waitBarrier(language);
    return this.openCached(language);
  }

  /** Open/cached handle without the barrier check: for code that already runs inside the barrier (installer validation). */
  openInsideBarrier(language: Language): Promise<Db | null> {
    return this.openCached(language);
  }

  private openCached(language: Language): Promise<Db | null> {
    let existing = this.catalogs.get(language);
    if (!existing) {
      existing = (async () => {
        const driver = await timed(`fdx:catalog-open-${language}`, () => this.source.open(language));
        if (!driver) return null;
        const db = new Db(driver, true);
        await db.initialize();
        return db;
      })();
      existing.catch(() => this.catalogs.delete(language));
      // A null result is not cached: the catalog may be installed a moment later.
      existing.then((db) => { if (db === null && this.catalogs.get(language) === existing) this.catalogs.delete(language); }, () => undefined);
      this.catalogs.set(language, existing);
    }
    return existing;
  }

  get canWriteCatalog(): boolean {
    return this.source.writable === true && typeof this.source.openWritable === 'function';
  }

  /**
   * Multi-domain read (user + catalog): captures collection revision + catalog epochs, runs `fn`, and if either moved retries once;
   * a second movement throws STALE_READ (the UI refetches once silently). A handle retired mid-read (raw driver error while a catalog
   * generation moved) is treated as movement too (E2 / N07).
   */
  async consistentRead<T>(languages: readonly Language[], fn: () => Promise<T>): Promise<T> {
    const snapshot = async () => ({
      revision: Number((await this.user.scalar<number>("SELECT collection_revision FROM app_state WHERE id = 'collection'")) ?? 0),
      epochs: languages.map((l) => this.epochs[l]),
      generations: languages.map((l) => this.generations[l])
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await snapshot();
      let result: T;
      try {
        result = await fn();
      } catch (error) {
        const now = await snapshot().catch(() => null);
        if (now && now.generations.some((g, i) => g !== before.generations[i])) continue; // the handle was retired under us: run it again
        throw error;
      }
      const after = await snapshot();
      if (before.revision === after.revision && before.epochs.every((e, i) => e === after.epochs[i]) && before.generations.every((g, i) => g === after.generations[i])) return result;
    }
    throw new CatalogError('STALE_READ', 'The data changed while it was being read. Try again.');
  }

  /**
   * E2 / N07: run a public multi-statement CATALOG read so that a handle retired mid-operation (install / rollback / uninstall activation, or a
   * sync's writable-handle swap) never surfaces as a raw driver error. If a catalog handle generation moved while `fn` ran (with or without an
   * error) the WHOLE operation is retried once (the retry waits at the barrier via `catalog()`, so it reads the new catalog or gets a typed
   * MAINTENANCE); a second movement is a typed `STALE_READ`. Errors with no generation movement propagate unchanged.
   */
  async protectedRead<T>(languages: readonly Language[], fn: () => Promise<T>): Promise<T> {
    const moved = (before: number[]) => languages.some((l, i) => this.generations[l] !== before[i]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = languages.map((l) => this.generations[l]);
      let result: T;
      try {
        result = await fn();
      } catch (error) {
        if (moved(before)) continue;
        throw error;
      }
      if (!moved(before)) return result;
    }
    throw new CatalogError('STALE_READ', 'The catalog changed while it was being read. Try again.');
  }

  /**
   * Run `fn` against a writable handle of the installed catalog (null catalog -> `fn` is not called and null is returned).
   * Holds the language barrier; the read-only handle is closed first and reopened lazily afterwards so readers never keep a stale copy.
   * `expectedEpoch` fences the write: a mismatch throws STALE_READ before anything opens (R10 generation fencing).
   */
  withWritableCatalog<T>(language: Language, fn: (db: Db) => Promise<T>, options: { expectedEpoch?: number } = {}): Promise<T | null> {
    return this.withBarrier([language], async () => {
      const open = this.source.openWritable;
      if (!open || !this.source.writable) return null;
      if (options.expectedEpoch !== undefined && options.expectedEpoch !== this.epochs[language]) {
        throw new CatalogError('STALE_READ', 'The catalog was replaced while this update was running');
      }
      await this.invalidateCatalog(language);
      const driver = await open.call(this.source, language);
      if (!driver) return null;
      const db = new Db(driver);
      try {
        await db.initialize();
        return await fn(db);
      } finally {
        await db.close().catch(() => undefined);
        await this.invalidateCatalog(language);
      }
    });
  }

  /** Drop the cached handle for a language (after install / uninstall / rollback) and bump its generation. */
  async invalidateCatalog(language: Language): Promise<void> {
    const existing = this.catalogs.get(language);
    this.catalogs.delete(language);
    this.generations[language] += 1;
    if (existing) {
      const db = await existing.catch(() => null);
      if (db) await db.close().catch(() => undefined);
    }
    await this.source.release?.(language);
  }

  async close(): Promise<void> {
    for (const language of ['en', 'ja'] as const) {
      const existing = this.catalogs.get(language);
      this.catalogs.delete(language);
      if (existing) await (await existing.catch(() => null))?.close().catch(() => undefined);
    }
    await this.user.close();
  }
}
