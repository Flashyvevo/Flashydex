import type { Language } from '@flashydex/schemas';
import { ActiveWorkError, CatalogError, MaintenanceError } from '../errors';
import type { DatabaseSet } from './database-set';

export type WorkKind = 'install' | 'uninstall' | 'rollback' | 'sync' | 'restore';

export interface WorkLease {
  readonly kind: WorkKind;
  readonly token: string;
  readonly languages: readonly Language[];
  /** Hold the per-language maintenance barrier around `fn` (readers get MAINTENANCE / wait; catalog() never reopens meanwhile). */
  withBarrier<T>(languages: readonly Language[], fn: () => Promise<T>): Promise<T>;
  release(): Promise<void>;
}

/**
 * D45 / R10: ONE admission coordinator. `admit` inserts the single durable `work_admission` row (PK 'lock'); a second admit of any
 * kind fails with ACTIVE_WORK (ACTIVE_SYNC when a sync is the one running or being admitted). In-process state mirrors the row so
 * a persistence-latched user DB still releases in memory; `reconcile()` (boot / storage.recover) drops rows no live lease owns.
 *
 * The coordinator also owns the per-language barrier and the content epoch used for generation fencing (see DatabaseSet).
 */
export class WorkCoordinator {
  private held: { kind: WorkKind; token: string; languages: readonly Language[] } | null = null;
  private pending = false;

  constructor(private readonly sets: DatabaseSet) {}

  get current(): { kind: WorkKind; languages: readonly Language[] } | null {
    return this.held ? { kind: this.held.kind, languages: this.held.languages } : null;
  }

  private busy(kind: WorkKind): ActiveWorkError {
    const syncInvolved = kind === 'sync' || this.held?.kind === 'sync';
    return new ActiveWorkError(syncInvolved ? 'ACTIVE_SYNC' : 'ACTIVE_WORK', 'Another download, update or restore is already running');
  }

  async admit(kind: WorkKind, options: { languages?: readonly Language[]; token: string; now: string }): Promise<WorkLease> {
    if (this.held || this.pending) throw this.busy(kind);
    this.pending = true;
    const languages = [...(options.languages ?? [])];
    try {
      await this.sets.user.transaction(async (tx) => {
        const row = await tx.rows("SELECT kind FROM work_admission WHERE id = 'lock'");
        if (row.length > 0) throw new ActiveWorkError(String(row[0]?.[0]) === 'sync' || kind === 'sync' ? 'ACTIVE_SYNC' : 'ACTIVE_WORK', 'Another download, update or restore is already running');
        await tx.run("INSERT INTO work_admission (id, kind, token, languages_json, acquired_at) VALUES ('lock', ?, ?, ?, ?)", [kind, options.token, JSON.stringify(languages), options.now]);
      });
    } catch (error) {
      this.pending = false;
      throw error;
    }
    this.held = { kind, token: options.token, languages };
    this.pending = false;
    let released = false;
    const lease: WorkLease = {
      kind, token: options.token, languages,
      withBarrier: (langs, fn) => this.sets.withBarrier(langs, fn),
      release: async () => {
        if (released) return;
        released = true;
        if (this.held?.token === options.token) this.held = null;
        try {
          await this.sets.user.transaction(async (tx) => { await tx.run("DELETE FROM work_admission WHERE id = 'lock' AND token = ?", [options.token]); });
        } catch {
          /* in-memory lease is gone; a stale row is dropped by reconcile() */
        }
      }
    };
    return lease;
  }

  /** Delete an admission row that no live lease owns (after a crash, or a latched failure). Returns whether a row was removed. */
  async reconcile(): Promise<boolean> {
    const rows = await this.sets.user.rows("SELECT token FROM work_admission WHERE id = 'lock'");
    if (rows.length === 0) return false;
    if (this.held && this.held.token === String(rows[0]?.[0])) return false;
    await this.sets.user.transaction(async (tx) => { await tx.run("DELETE FROM work_admission WHERE id = 'lock'"); });
    return true;
  }
}

export const barrierError = (language: Language): CatalogError | MaintenanceError => { void language; return new MaintenanceError(); };
