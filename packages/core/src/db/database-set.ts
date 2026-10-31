import type { Language } from '@flashydex/schemas';
import { Db, type SqlDriver } from './sql';

/** Opens (read-only) catalog connections. `null` = no catalog installed for that language (a normal state). */
export interface CatalogSource {
  open(language: Language): Promise<SqlDriver | null>;
  /**
   * Optional: a READ-WRITE handle to the installed catalog, used only by SyncService (`prices_only`) to refresh
   * `catalog_latest_prices`. Absent = this platform cannot update catalog prices (the UI shows an honest disabled state).
   * The read-only handle is retired before this opens and reopened after (see `DatabaseSet.withWritableCatalog`).
   */
  openWritable?(language: Language): Promise<SqlDriver | null>;
  /** Called when a catalog handle is retired (install / uninstall / rollback). */
  release?(language: Language): Promise<void>;
}

/**
 * The user DB plus 0..2 catalog DBs. One connection per file, no ATTACH: repositories do app-level joins (CATALOG-PACKS join plans).
 * `generation(language)` increases whenever a catalog handle is replaced, so cached reads can detect a swap.
 */
export class DatabaseSet {
  private readonly catalogs = new Map<Language, Promise<Db | null>>();
  private readonly generations: Record<Language, number> = { en: 0, ja: 0 };

  constructor(readonly user: Db, private readonly source: CatalogSource) {}

  generation(language: Language): number {
    return this.generations[language];
  }

  /** Read-only catalog handle, or null when that language is not installed. Never creates a database. */
  catalog(language: Language): Promise<Db | null> {
    let existing = this.catalogs.get(language);
    if (!existing) {
      existing = (async () => {
        const driver = await this.source.open(language);
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
    return typeof this.source.openWritable === 'function';
  }

  private writeTail: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` against a writable handle of the installed catalog (null catalog -> `fn` is not called and null is returned).
   * Serialized across languages; the read-only handle is closed first and reopened lazily afterwards so readers never keep a
   * stale copy (web keeps each connection in memory).
   */
  withWritableCatalog<T>(language: Language, fn: (db: Db) => Promise<T>): Promise<T | null> {
    const run = async (): Promise<T | null> => {
      const open = this.source.openWritable;
      if (!open) return null;
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
    };
    const next = this.writeTail.then(run, run);
    this.writeTail = next.catch(() => undefined);
    return next;
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
