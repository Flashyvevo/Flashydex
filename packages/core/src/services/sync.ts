import { ById, PageQuery, SyncStart, type Input, type Language, type Page, type SyncDto } from '@flashydex/schemas';
import {
  encodeIdForPath, mapCard, mapSet, sha256Hex, type CatalogLatestPriceRow, type CatalogSetRow, type MappedCard, type RawCard, type RawSetDetail
} from '../catalog/tcgdex';
import type { WorkLease } from '../db/coordinator';
import { chunk, placeholders, type Exec } from '../db/sql';
import { ActiveWorkError, CatalogError, DomainError, InvalidStateError, NotFoundError, UnsupportedCapabilityError, toDomainError } from '../errors';
import type { Platform } from '../platform/platform';
import { parse, readSettings, type ServiceContext } from './context';

/**
 * SyncService (Phase 1): `prices_only`, `refresh` and `incremental` (API.md SyncService, DATA-MODEL checkpoint v3).
 *
 *  - prices_only: the card list of every selected set is the distinct OWNED catalog ids of that set, frozen at start.
 *  - refresh (single-set fill-in / unpublished recheck): for each selected (language,set) the set detail is fetched, then EVERY card of
 *    that set; the writable catalog gets the set row, card, variant and latest-price rows of that set only. Never touches owned_cards,
 *    settings, custom cards or other sets. `catalog_meta` is left alone on purpose: its counts/hashes describe the INSTALLED PACK
 *    (the release the receipt refers to), not the refreshed contents.
 *  - incremental: discovery lists the sets of each selected language (`/{lang}/sets`) and compares them with `catalog_sets` of the
 *    installed catalog: sets missing from the catalog, unpublished shells, and sets whose name / total / official count changed are
 *    refreshed exactly like `refresh`; unchanged sets are marked done without a single card request. Discovery is frozen into the
 *    checkpoint (a resumed run never re-discovers). Languages whose catalog is not installed are skipped with a warning
 *    CATALOG_NOT_INSTALLED (a sync never installs a catalog). It does NOT delete sets/cards that disappeared upstream, does not touch
 *    pack metadata and does not re-fetch cards of unchanged sets.
 *  - Network: `Platform.http` GET `https://api.tcgdex.net/v2/...`; at most `concurrency` (<= 8) requests in flight; 429/5xx/timeout/bad-JSON
 *    retry with exponential backoff, honouring `Retry-After` (shared pause for every worker). A unit that still fails after the attempts
 *    is counted in `cardsFailed`; it never aborts the rest.
 *  - Writes, per batch of <= 25 cards, with a DURABLE PENDING BATCH (R07, ARCHITECTURE two-commit replay):
 *      (a) fetch + map; (b) USER commit: `checkpoint.pendingBatch` = the exact mapped rows + payload hashes (FIRST OBSERVATION WINS);
 *      (c) CATALOG commit (idempotent upsert); (d) USER commit: history (INSERT OR IGNORE by observation key) + pendingBatch cleared +
 *      counters, in one fenced transaction. A kill anywhere after (b) replays the stored rows on resume; nothing is refetched, so a
 *      changed upstream response can never replace what was first observed. A kill before (b) simply refetches.
 *  - Admission (D45): one durable `work_admission` row for the whole run (released in every end path). Fencing (R10): the catalog epoch
 *    is captured at run start; every catalog write and every user commit re-checks it and aborts the batch (STALE_READ) on mismatch.
 */
type SetKey = { language: Language; setId: string };
type CardState = { id: string; status: 'pending' | 'done' | 'failed'; errorCode: string | null };
type SetState = SetKey & {
  status: 'pending' | 'running' | 'done' | 'failed' | 'unpublished';
  manifestFetched: boolean; detailEtag: string | null; checkedAt: string | null; advertisedTotal: number | null;
  cardsTotal: number | null; cardsDone: number; cardsFailed: number; cards: CardState[];
  /** refresh / incremental: the set row to upsert (frozen with the manifest) and whether it was applied. */
  setRow?: CatalogSetRow | null; setApplied?: boolean;
};
type Warning = { code: string; language: Language; cardId: string | null; message: string };
type PendingCard = { id: string; payloadHash: string; prices: CatalogLatestPriceRow[]; mapped: MappedCard | null; warnings: Array<{ code: string; cardId: string | null; message: string }> };
export type PendingBatch = {
  language: Language; setId: string; epoch: number; createdAt: string; setRow: CatalogSetRow | null;
  /**
   * N02: the PERSISTED installed-content identity (`installed_catalogs`: generation|status|version|sha256) this batch was fetched against.
   * `epoch` is only the in-process handle counter and is meaningless after a restart; a replay is allowed iff the identity still matches.
   */
  identity: string | null;
  cards: PendingCard[]; failed: Array<{ id: string; code: string }>;
};
type Checkpoint = {
  version: 3; languages: Language[]; selection: SyncDto['selection'];
  /** `generation` = the catalog EPOCH (in-process) captured when the run (re)started. */
  catalogGenerations: Array<{ language: Language; generation: number }>;
  /** Persisted installed-content identity per language captured when the run (re)started; every fenced user commit re-checks it (N02). */
  catalogIdentities?: Array<{ language: Language; identity: string }>;
  pendingBatch: PendingBatch | null;
  lists: never[]; sets: SetState[]; warnings: Warning[]; discovered?: boolean;
};

export interface SyncOptions {
  concurrency?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  batchSize?: number;
  /** Test seam: replaces real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: await the background run inside `start`. */
  awaitRun?: boolean;
  apiBase?: string;
  /** Test seam: called after the pending batch is committed and BEFORE the catalog write (a throw simulates a kill). */
  faultAfterPendingCommit?: () => void | Promise<void>;
  /** Test seam: called after the CATALOG commit and before the USER commit (a throw simulates a kill between the two commits). */
  faultAfterCatalogCommit?: () => void | Promise<void>;
  /** Test seam: called after fetching a batch, before the pending batch is committed (a throw simulates a kill). */
  faultBeforePendingCommit?: () => void | Promise<void>;
}

export type SyncCapabilities = { pricesOnly: boolean; refresh: boolean; incremental: boolean; reason: string | null };

const MAX_WARNINGS = 100;
const BATCH_SIZE = 25;
const SYNC_COLS = {
  id: 'id', status: 'status', mode: 'mode', languagesJson: 'languages_json', selectionJson: 'selection_json', attempt: 'attempt', setsTotal: 'sets_total',
  setsDone: 'sets_done', cardsTotal: 'cards_total', cardsDone: 'cards_done', cardsFailed: 'cards_failed', checkpointJson: 'checkpoint_json',
  lastErrorJson: 'last_error_json', heartbeatAt: 'heartbeat_at', leaseExpiresAt: 'lease_expires_at', startedAt: 'started_at', finishedAt: 'finished_at',
  createdAt: 'created_at', updatedAt: 'updated_at'
} as const;
type SyncRow = {
  id: string; status: SyncDto['status']; mode: SyncDto['mode']; languagesJson: string; selectionJson: string; attempt: number; setsTotal: number | null;
  setsDone: number; cardsTotal: number | null; cardsDone: number; cardsFailed: number; checkpointJson: string; lastErrorJson: string | null;
  heartbeatAt: string | null; leaseExpiresAt: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string; updatedAt: string;
};

class Fenced extends Error {}
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const staleCatalog = () => new CatalogError('STALE_READ', 'The catalog was replaced while this update was running. Resume it to continue.');

export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

type FetchResult<T> = { ok: true; body: T } | { ok: false; code: string };

export class SyncService {
  private readonly opts: Required<Omit<SyncOptions, 'awaitRun' | 'faultAfterCatalogCommit' | 'faultAfterPendingCommit' | 'faultBeforePendingCommit'>> & Pick<SyncOptions, 'faultAfterCatalogCommit' | 'faultAfterPendingCommit' | 'faultBeforePendingCommit'> & { awaitRun: boolean };
  private pauseUntil = 0;
  private active: Promise<void> | null = null;

  constructor(private readonly ctx: ServiceContext, private readonly platform: Platform, options: SyncOptions = {}) {
    this.opts = {
      concurrency: Math.min(8, Math.max(1, options.concurrency ?? 8)),
      maxAttempts: options.maxAttempts ?? 4,
      baseDelayMs: options.baseDelayMs ?? 500,
      maxDelayMs: options.maxDelayMs ?? 30_000,
      timeoutMs: options.timeoutMs ?? 15_000,
      batchSize: Math.min(BATCH_SIZE, options.batchSize ?? BATCH_SIZE),
      sleep: options.sleep ?? defaultSleep,
      awaitRun: options.awaitRun ?? false,
      apiBase: options.apiBase ?? 'https://api.tcgdex.net/v2',
      faultAfterCatalogCommit: options.faultAfterCatalogCommit,
      faultAfterPendingCommit: options.faultAfterPendingCommit,
      faultBeforePendingCommit: options.faultBeforePendingCommit
    };
  }

  private get user() {
    return this.ctx.databases.user;
  }

  /** What this platform can do. Honest: the UI disables what is false. */
  capabilities(): SyncCapabilities {
    if (!this.ctx.databases.canWriteCatalog) {
      return { pricesOnly: false, refresh: false, incremental: false, reason: 'Catalog updates need a writable catalog, which this build doesn’t have.' };
    }
    return { pricesOnly: true, refresh: true, incremental: true, reason: null };
  }

  /** Resolves when the in-flight background run (if any) is finished. For tests and graceful shutdown. */
  idle(): Promise<void> {
    return this.active ?? Promise.resolve();
  }

  private requireCapability(mode: SyncDto['mode']): void {
    const caps = this.capabilities();
    const ok = mode === 'prices_only' ? caps.pricesOnly : mode === 'refresh' ? caps.refresh : caps.incremental;
    if (!ok) throw new UnsupportedCapabilityError(caps.reason ?? 'Catalog updates are not available');
  }

  private admit(languages: readonly Language[]): Promise<WorkLease> {
    return this.ctx.databases.coordinator.admit('sync', { languages, token: this.ctx.env.ids.uuid(), now: this.ctx.env.clock.now() });
  }

  private epochs(languages: readonly Language[]): Checkpoint['catalogGenerations'] {
    return languages.map((language) => ({ language, generation: this.ctx.databases.epoch(language) }));
  }

  /** N02: the persisted installed-content identity of one language (survives restarts; changes on every install/rollback/uninstall/recovery receipt write). */
  private async identityOf(q: Pick<Exec, 'rows'>, language: Language): Promise<string> {
    const r = (await q.rows('SELECT generation, status, version, sha256 FROM installed_catalogs WHERE language = ?', [language]))[0];
    return r ? `${String(r[0])}|${String(r[1])}|${String(r[2] ?? '')}|${String(r[3] ?? '')}` : 'none';
  }

  private async identities(languages: readonly Language[]): Promise<NonNullable<Checkpoint['catalogIdentities']>> {
    const out: NonNullable<Checkpoint['catalogIdentities']> = [];
    for (const language of languages) out.push({ language, identity: await this.identityOf(this.user, language) });
    return out;
  }

  /* ------------------------------------------------------------------------------------------ API */
  async start(input: Input<typeof SyncStart>): Promise<SyncDto> {
    const request = parse(SyncStart, input);
    const mode = request.mode;
    this.requireCapability(mode);
    if (mode !== 'incremental' && (!request.selection || request.selection.scope !== 'followed')) {
      throw new UnsupportedCapabilityError(mode === 'refresh' ? 'Refreshing needs a list of sets' : 'Price updates need a list of sets');
    }
    const seen = new Set<string>();
    const followed = request.selection?.scope === 'followed'
      ? request.selection.sets.filter((s) => (seen.has(`${s.language}\u0000${s.setId}`) ? false : (seen.add(`${s.language}\u0000${s.setId}`), true)))
      : [];
    const requestedLanguages = ([...new Set(followed.map((s) => s.language))].sort() as Language[]);
    // Admission first (D45): the very first thing a start does after cheap validation, so racing starts are decided here, not by read latency.
    const lease = await this.admit(requestedLanguages.length > 0 ? requestedLanguages : (request.languages ?? ['en', 'ja']));
    try {
      let languages = requestedLanguages;
      let selection: SyncDto['selection'] = { scope: 'followed', sets: followed };
      if (mode === 'incremental' && followed.length === 0) {
        const settings = await this.user.read((q) => readSettings(q));
        languages = [...new Set(request.languages ?? settings.languages)].sort() as Language[];
        selection = { scope: 'all', sets: [] };
      }
      const states: SetState[] = [];
      if (mode === 'prices_only') {
        // Frozen manifest = distinct OWNED catalog ids per selected set.
        for (const key of followed) {
          const rows = await this.user.rows(
            'SELECT DISTINCT catalog_card_id FROM owned_cards WHERE catalog_card_id IS NOT NULL AND language = ? AND set_id = ? ORDER BY catalog_card_id ASC',
            [key.language, key.setId]
          );
          const cards: CardState[] = rows.map((r) => ({ id: String(r[0]), status: 'pending', errorCode: null }));
          states.push({
            ...key, status: cards.length === 0 ? 'done' : 'pending', manifestFetched: true, detailEtag: null, checkedAt: null, advertisedTotal: null,
            cardsTotal: cards.length, cardsDone: 0, cardsFailed: 0, cards
          });
        }
      } else {
        // refresh / incremental write INTO an installed catalog; a sync never installs one.
        for (const language of languages) {
          if (!(await this.ctx.databases.catalog(language))) {
            if (mode === 'refresh') throw new CatalogError('CATALOG_NOT_INSTALLED', `The ${language} catalog is not installed`);
          }
        }
        if (mode === 'refresh') {
          for (const key of followed) {
            states.push({
              ...key, status: 'pending', manifestFetched: false, detailEtag: null, checkedAt: null, advertisedTotal: null, cardsTotal: null, cardsDone: 0, cardsFailed: 0, cards: [],
              setRow: null, setApplied: false
            });
          }
        } else {
          let any = false;
          for (const language of languages) if (await this.ctx.databases.catalog(language)) any = true;
          if (!any) throw new CatalogError('CATALOG_NOT_INSTALLED', 'No catalog is installed');
        }
      }
      const checkpoint: Checkpoint = {
        version: 3, languages, selection, catalogGenerations: this.epochs(languages), pendingBatch: null, lists: [], sets: states, warnings: [],
        ...(mode === 'incremental' ? { discovered: false } : {})
      };
      const cardsTotal = mode === 'prices_only' ? states.reduce((n, s) => n + (s.cardsTotal ?? 0), 0) : null;
      const id = this.ctx.env.ids.uuid();
      const token = this.ctx.env.ids.uuid();
      const now = this.ctx.env.clock.now();
      await this.user.transaction(async (tx) => {
        const busy = await tx.rows("SELECT 1 FROM sync_state WHERE lock_key IS NOT NULL UNION ALL SELECT 1 FROM catalog_install_jobs WHERE lock_key IS NOT NULL LIMIT 1");
        if (busy.length > 0) throw new ActiveWorkError('ACTIVE_SYNC', 'A download or catalog update is already running');
        await tx.run(
          `INSERT INTO sync_state (id, status, mode, languages_json, selection_json, lock_key, worker_token, attempt, sets_total, sets_done, cards_total, cards_done,
             cards_failed, checkpoint_json, last_error_json, heartbeat_at, lease_expires_at, started_at, finished_at, created_at, updated_at)
           VALUES (?, 'queued', ?, ?, ?, 'catalog', ?, 1, ?, ?, ?, 0, 0, ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
          [id, mode, JSON.stringify(languages), JSON.stringify(selection), token, mode === 'incremental' ? null : states.length, states.filter((s) => s.status === 'done').length,
            cardsTotal, JSON.stringify(checkpoint), now, now, now]
        );
      });
      this.launch(id, token, lease);
      if (this.opts.awaitRun) await this.idle();
      return this.get({ id });
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  async list(input: Input<typeof PageQuery>): Promise<Page<SyncDto>> {
    const { offset, limit } = parse(PageQuery, input);
    const total = Number(await this.user.scalar<number>('SELECT COUNT(*) FROM sync_state'));
    const rows = await this.user.select<SyncRow>(SYNC_COLS, 'FROM sync_state ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', [limit, offset]);
    const data = rows.map((r) => this.toDto(r));
    return { data, page: { offset, limit, total, hasMore: offset + data.length < total } };
  }

  async get(input: Input<typeof ById>): Promise<SyncDto> {
    const { id } = parse(ById, input);
    const row = await this.row(id);
    if (!row) throw new NotFoundError('Sync', id);
    return this.toDto(row);
  }

  async cancel(input: Input<typeof ById>): Promise<SyncDto> {
    const { id } = parse(ById, input);
    const row = await this.row(id);
    if (!row) throw new NotFoundError('Sync', id);
    if (row.status === 'queued' || row.status === 'running') {
      await this.user.run("UPDATE sync_state SET status = 'cancel_requested', updated_at = ? WHERE id = ? AND status IN ('queued','running')", [this.ctx.env.clock.now(), id]);
    }
    return this.get({ id });
  }

  async resume(input: Input<typeof ById>): Promise<SyncDto> {
    const { id } = parse(ById, input);
    const row = await this.row(id);
    if (!row) throw new NotFoundError('Sync', id);
    if (row.status === 'completed') throw new InvalidStateError('A completed update cannot be resumed');
    if (row.status === 'queued' || row.status === 'running' || row.status === 'cancel_requested') throw new ActiveWorkError('ACTIVE_SYNC', 'This update is already running');
    this.requireCapability(row.mode);
    const cp = this.readCheckpoint(row);
    if (!cp) throw new InvalidStateError('This update can’t be resumed; start a new one');
    const lease = await this.admit(cp.languages);
    try {
      for (const s of cp.sets) {
        for (const c of s.cards) if (c.status === 'failed') { c.status = 'pending'; c.errorCode = null; }
        s.cardsFailed = 0;
        if (s.status === 'failed' || s.status === 'running') s.status = 'pending';
      }
      const token = this.ctx.env.ids.uuid();
      const now = this.ctx.env.clock.now();
      await this.user.transaction(async (tx) => {
        const busy = await tx.rows("SELECT 1 FROM sync_state WHERE lock_key IS NOT NULL UNION ALL SELECT 1 FROM catalog_install_jobs WHERE lock_key IS NOT NULL LIMIT 1");
        if (busy.length > 0) throw new ActiveWorkError('ACTIVE_SYNC', 'A download or catalog update is already running');
        await tx.run(
          `UPDATE sync_state SET status = 'queued', lock_key = 'catalog', worker_token = ?, attempt = attempt + 1, checkpoint_json = ?, cards_failed = 0,
             sets_done = ?, last_error_json = NULL, finished_at = NULL, heartbeat_at = ?, updated_at = ? WHERE id = ?`,
          [token, JSON.stringify(cp), cp.sets.filter((s) => s.status === 'done' || s.status === 'unpublished').length, now, now, id]
        );
      });
      this.launch(id, token, lease);
      if (this.opts.awaitRun) await this.idle();
      return this.get({ id });
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  /** Boot recovery: a run that was active when the app died becomes `interrupted` (resumable) and releases the lock + admission row. */
  async recover(): Promise<{ interrupted: number }> {
    await this.ctx.databases.coordinator.reconcile().catch(() => false);
    const rows = await this.user.rows("SELECT id FROM sync_state WHERE status IN ('queued','running','cancel_requested') OR lock_key IS NOT NULL");
    if (rows.length === 0) return { interrupted: 0 };
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      await tx.run(
        `UPDATE sync_state SET status = CASE WHEN status IN ('queued','running','cancel_requested') THEN 'interrupted' ELSE status END, lock_key = NULL,
           worker_token = NULL, updated_at = ?, finished_at = COALESCE(finished_at, ?) WHERE status IN ('queued','running','cancel_requested') OR lock_key IS NOT NULL`,
        [now, now]
      );
    });
    return { interrupted: rows.length };
  }

  /* ------------------------------------------------------------------------------------------ engine */
  private launch(id: string, token: string, lease: WorkLease): void {
    const run = this.run(id, token, lease).catch(() => undefined);
    this.active = run.finally(() => { if (this.active === run) this.active = null; });
  }

  private async row(id: string): Promise<SyncRow | null> {
    return (await this.user.select<SyncRow>(SYNC_COLS, 'FROM sync_state WHERE id = ?', [id]))[0] ?? null;
  }

  private readCheckpoint(row: SyncRow): Checkpoint | null {
    try {
      const cp = JSON.parse(row.checkpointJson) as Checkpoint;
      if (cp.version !== 3 || !Array.isArray(cp.sets)) return null;
      cp.pendingBatch ??= null;
      cp.catalogGenerations ??= [];
      return cp;
    } catch {
      return null;
    }
  }

  private toDto(row: SyncRow): SyncDto {
    const cp = this.readCheckpoint(row);
    return {
      id: row.id, status: row.status, languages: JSON.parse(row.languagesJson) as Language[], selection: JSON.parse(row.selectionJson) as SyncDto['selection'],
      mode: row.mode, attempt: row.attempt, setsTotal: row.setsTotal, setsDone: row.setsDone, cardsTotal: row.cardsTotal, cardsDone: row.cardsDone,
      cardsFailed: row.cardsFailed,
      sets: (cp?.sets ?? []).map((s) => ({ language: s.language, setId: s.setId, status: s.status, cardsTotal: s.cardsTotal, cardsDone: s.cardsDone, cardsFailed: s.cardsFailed })),
      warnings: (cp?.warnings ?? []).slice(0, MAX_WARNINGS),
      lastError: row.lastErrorJson ? (JSON.parse(row.lastErrorJson) as SyncDto['lastError']) : null,
      heartbeatAt: row.heartbeatAt, leaseExpiresAt: row.leaseExpiresAt, startedAt: row.startedAt, finishedAt: row.finishedAt, createdAt: row.createdAt, updatedAt: row.updatedAt
    };
  }

  private async finish(id: string, token: string, status: 'completed' | 'failed' | 'cancelled', lastError: { code: string; message: string } | null): Promise<void> {
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      const r = await tx.rows('SELECT worker_token FROM sync_state WHERE id = ?', [id]);
      if (r[0]?.[0] !== token) throw new Fenced();
      await tx.run('UPDATE sync_state SET status = ?, lock_key = NULL, worker_token = NULL, last_error_json = ?, finished_at = ?, heartbeat_at = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?', [
        status, lastError ? JSON.stringify(lastError) : null, now, now, now, id
      ]);
    });
  }

  private async run(id: string, token: string, lease: WorkLease): Promise<void> {
    this.pauseUntil = 0;
    try {
      const startedAt = this.ctx.env.clock.now();
      await this.user.run("UPDATE sync_state SET status = 'running', started_at = COALESCE(started_at, ?), heartbeat_at = ?, updated_at = ? WHERE id = ? AND worker_token = ? AND status = 'queued'", [startedAt, startedAt, startedAt, id, token]);
      const row = await this.row(id);
      const cp = row ? this.readCheckpoint(row) : null;
      if (!row || !cp) throw new InvalidStateError('The update state is unreadable');
      const mode = row.mode;

      // Replay a durable pending batch EXACTLY as first observed (R07) - unless the installed catalog was replaced since (then the batch is
      // dropped and refetched). N02: "replaced" is decided by the PERSISTED installed identity, never by the in-process epoch counter.
      cp.catalogIdentities ??= [];
      if (cp.pendingBatch) {
        const pending = cp.pendingBatch;
        const identityNow = await this.identityOf(this.user, pending.language);
        if (pending.identity === identityNow && cp.sets.some((s) => s.language === pending.language && s.setId === pending.setId)) {
          pending.epoch = this.ctx.databases.epoch(pending.language); // same content: adopt this process's handle counter for the write fence
          cp.catalogGenerations = this.epochs(cp.languages);
          cp.catalogIdentities = await this.identities(cp.languages);
          await this.executePending(id, token, cp, pending, mode);
        } else {
          cp.pendingBatch = null;
          this.warn(cp, { code: 'BATCH_DISCARDED', language: pending.language, cardId: null, message: 'A saved batch belonged to a replaced catalog and was fetched again' });
        }
      }
      cp.catalogGenerations = this.epochs(cp.languages); // fence everything from here on against THIS epoch ...
      cp.catalogIdentities = await this.identities(cp.languages); // ... and THIS persisted installed identity
      await this.persist(id, token, cp, []);

      if (mode === 'incremental' && cp.discovered !== true) await this.discover(id, token, cp);

      for (const set of cp.sets) {
        if (set.status === 'done' || set.status === 'unpublished') continue;
        if (!(await this.processSet(id, token, cp, set, mode))) return; // cancelled
      }
      // N06: a failed (or never-finished) SET or discovery unit is a failed run too, not only failed cards. Resumable, with an actionable error.
      const failedCards = cp.sets.reduce((n, s) => n + s.cardsFailed, 0);
      const failedSets = cp.sets.filter((s) => s.status === 'failed' || s.status === 'pending' || s.status === 'running').length;
      const parts: string[] = [];
      if (failedSets > 0) parts.push(`${failedSets} set${failedSets === 1 ? '' : 's'} could not be fetched`);
      if (failedCards > 0) parts.push(`${failedCards} card${failedCards === 1 ? '' : 's'} could not be updated`);
      const failed = failedSets > 0 || failedCards > 0;
      await this.finish(id, token, failed ? 'failed' : 'completed', failed ? { code: 'PARTIAL_FAILURE', message: `${parts.join(' and ')}. Try again to resume.` } : null);
    } catch (error) {
      if (error instanceof Fenced) return; // a newer attempt owns the run
      const domain = error instanceof DomainError ? error : toDomainError(error);
      await this.finish(id, token, 'failed', { code: domain.code, message: domain.message }).catch(() => undefined);
    } finally {
      await lease.release();
    }
  }

  /** Returns false when the run was cancelled (already finished as such). */
  private async processSet(id: string, token: string, cp: Checkpoint, set: SetState, mode: SyncDto['mode']): Promise<boolean> {
    set.status = 'running';
    if (mode !== 'prices_only' && !set.manifestFetched) {
      const loaded = await this.loadSetManifest(cp, set);
      if (!loaded) { await this.persist(id, token, cp, []); return true; }
      await this.persist(id, token, cp, []);
    }
    const pending = set.cards.filter((c) => c.status !== 'done');
    if (mode !== 'prices_only' && set.setRow && !set.setApplied && pending.length === 0) {
      await this.commitAndExecute(id, token, cp, set, mode, []); // an empty / unpublished shell still gets its set row
    }
    for (const batch of chunk(pending, this.opts.batchSize)) {
      const current = await this.row(id);
      if (!current || current.status === 'cancel_requested') {
        await this.persist(id, token, cp, []);
        await this.finish(id, token, 'cancelled', null);
        return false;
      }
      const results = await this.fetchBatch(set, batch, mode);
      await this.opts.faultBeforePendingCommit?.();
      await this.commitAndExecute(id, token, cp, set, mode, results);
    }
    set.status = set.cardsFailed > 0 ? 'failed' : set.setRow?.status === 'unpublished' && set.cards.length === 0 ? 'unpublished' : 'done';
    await this.persist(id, token, cp, []);
    return true;
  }

  private warn(cp: Checkpoint, w: Warning): void {
    if (cp.warnings.length < MAX_WARNINGS) cp.warnings.push({ ...w, message: w.message.slice(0, 200) });
  }

  private assertEpoch(cp: Checkpoint, language: Language): void {
    const captured = cp.catalogGenerations.find((g) => g.language === language);
    if (captured && captured.generation !== this.ctx.databases.epoch(language)) throw staleCatalog();
  }

  /** Build the pending batch from fetch results, COMMIT it (first observation wins), then execute it. */
  private async commitAndExecute(id: string, token: string, cp: Checkpoint, set: SetState, mode: SyncDto['mode'], results: FetchedCard[]): Promise<void> {
    this.assertEpoch(cp, set.language);
    const pending: PendingBatch = {
      language: set.language, setId: set.setId, epoch: this.ctx.databases.epoch(set.language), createdAt: this.ctx.env.clock.now(),
      identity: cp.catalogIdentities?.find((i) => i.language === set.language)?.identity ?? null,
      setRow: mode !== 'prices_only' && set.setRow && !set.setApplied ? set.setRow : null,
      cards: results.filter((r): r is Extract<FetchedCard, { ok: true }> => r.ok).map((r) => ({ id: r.id, payloadHash: r.payloadHash, prices: r.prices, mapped: mode === 'prices_only' ? null : r.mapped, warnings: r.warnings })),
      failed: results.filter((r): r is Extract<FetchedCard, { ok: false }> => !r.ok).map((r) => ({ id: r.id, code: r.code }))
    };
    cp.pendingBatch = pending;
    await this.persist(id, token, cp, [], [set.language]); // USER commit #1: the exact payload, durable BEFORE the catalog is touched (fenced on the installed identity)
    await this.opts.faultAfterPendingCommit?.();
    await this.executePending(id, token, cp, pending, mode);
  }

  /** (c) catalog commit (idempotent) then (d) fenced user commit with history + pendingBatch cleared. */
  private async executePending(id: string, token: string, cp: Checkpoint, pending: PendingBatch, mode: SyncDto['mode']): Promise<void> {
    const set = cp.sets.find((s) => s.language === pending.language && s.setId === pending.setId) as SetState;
    const written = await this.writeCatalog(pending, mode);
    await this.opts.faultAfterCatalogCommit?.();
    for (const f of pending.failed) {
      const card = set.cards.find((c) => c.id === f.id);
      if (card) { card.status = 'failed'; card.errorCode = f.code; }
    }
    for (const c of pending.cards) {
      const card = set.cards.find((x) => x.id === c.id);
      for (const w of c.warnings) this.warn(cp, { code: w.code, language: set.language, cardId: w.cardId, message: w.message });
      if (!card) continue;
      if (written.missing.has(c.id)) {
        card.status = 'failed';
        card.errorCode = 'NOT_IN_CATALOG';
        this.warn(cp, { code: 'NOT_IN_CATALOG', language: set.language, cardId: c.id, message: 'This card is no longer in the installed catalog' });
      } else {
        card.status = 'done';
        card.errorCode = null;
      }
    }
    if (pending.setRow) set.setApplied = true;
    set.cardsDone = set.cards.filter((c) => c.status === 'done').length;
    set.cardsFailed = set.cards.filter((c) => c.status === 'failed').length;
    cp.pendingBatch = null;
    const history = pending.cards.filter((c) => !written.missing.has(c.id)).map((c) => ({ language: pending.language, prices: c.prices }));
    await this.persist(id, token, cp, history, [pending.language]);
  }

  /** Fenced progress commit; `prices` become personal history (idempotent by observation key). */
  private async persist(id: string, token: string, cp: Checkpoint, batches: Array<{ language: Language; prices: CatalogLatestPriceRow[] }>, fence: Language[] = []): Promise<void> {
    const now = this.ctx.env.clock.now();
    const cardsDone = cp.sets.reduce((n, s) => n + s.cardsDone, 0);
    const cardsFailed = cp.sets.reduce((n, s) => n + s.cardsFailed, 0);
    const setsDone = cp.sets.filter((s) => s.status === 'done' || s.status === 'unpublished').length;
    await this.user.transaction(async (tx: Exec) => {
      const r = await tx.rows('SELECT worker_token FROM sync_state WHERE id = ?', [id]);
      if (r[0]?.[0] !== token) throw new Fenced();
      for (const language of fence) {
        this.assertEpoch(cp, language); // generation fencing inside the write transaction
        const captured = cp.catalogIdentities?.find((i) => i.language === language);
        if (captured && captured.identity !== (await this.identityOf(tx, language))) throw staleCatalog(); // N02: persisted identity
      }
      for (const batch of batches) {
        for (const p of batch.prices) {
          await tx.run(
            `INSERT OR IGNORE INTO price_snapshots (id, catalog_card_id, language, source, variant, variant_detail, provider_variant_key, currency,
               low_cents, mid_cents, high_cents, market_cents, trend_cents, source_updated_at, captured_at, observation_key)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM catalog_identities WHERE language = ? AND id = ?)`,
            [this.ctx.env.ids.uuid(), p.catalogCardId, p.language, p.source, p.variant, p.variantDetail, p.providerVariantKey, p.currency, p.lowCents, p.midCents, p.highCents,
              p.marketCents, p.trendCents, p.sourceUpdatedAt, p.capturedAt, p.observationKey, p.language, p.catalogCardId]
          );
        }
      }
      await tx.run(
        `UPDATE sync_state SET checkpoint_json = ?,
           sets_total = CASE WHEN mode = 'prices_only' THEN sets_total WHEN mode = 'incremental' AND ? = 0 THEN sets_total ELSE ? END,
           sets_done = ?, cards_done = ?, cards_failed = ?,
           cards_total = CASE WHEN mode = 'prices_only' THEN cards_total ELSE ? END, heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ?`,
        [JSON.stringify(cp), cp.discovered === true ? 1 : 0, cp.sets.length, setsDone, cardsDone, cardsFailed, cp.sets.reduce((n, s) => n + (s.cardsTotal ?? 0), 0), now,
          new Date(Date.parse(now) + 60_000).toISOString(), now, id]
      );
    });
  }

  /** Apply a pending batch to the writable catalog (idempotent upserts). Never touches card metadata for prices_only. */
  private async writeCatalog(pending: PendingBatch, mode: SyncDto['mode']): Promise<{ missing: Set<string> }> {
    const missing = new Set<string>();
    const { language } = pending;
    if (pending.cards.length === 0 && !pending.setRow) return { missing };
    const result = await this.ctx.databases.withWritableCatalog(language, async (db) => {
      const existing = new Set<string>();
      if (mode === 'prices_only') {
        for (const part of chunk(pending.cards.map((c) => c.id), 100)) {
          for (const r of await db.rows(`SELECT id FROM catalog_cards WHERE language = ? AND id IN (${placeholders(part.length)})`, [language, ...part])) existing.add(String(r[0]));
        }
      }
      await db.transaction(async (tx) => {
        if (mode !== 'prices_only') {
          if (pending.setRow) await this.upsertSet(tx, pending.setRow);
          for (const c of pending.cards) {
            if (!c.mapped) continue;
            await this.upsertCard(tx, c.mapped);
          }
          return;
        }
        for (const entry of pending.cards) {
          if (!existing.has(entry.id)) { missing.add(entry.id); continue; }
          for (const p of entry.prices) await this.upsertPrice(tx, p);
        }
      });
      return true;
    }, { expectedEpoch: pending.epoch });
    if (result === null) for (const c of pending.cards) missing.add(c.id); // catalog vanished: nothing was written
    return { missing };
  }

  private async upsertPrice(tx: Exec, p: CatalogLatestPriceRow): Promise<void> {
    await tx.run(
      `INSERT OR REPLACE INTO catalog_latest_prices (id, catalog_card_id, language, source, variant, variant_detail, provider_variant_key, currency,
         low_cents, mid_cents, high_cents, market_cents, trend_cents, source_updated_at, captured_at, observation_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.observationKey, p.catalogCardId, p.language, p.source, p.variant, p.variantDetail, p.providerVariantKey, p.currency, p.lowCents, p.midCents, p.highCents,
        p.marketCents, p.trendCents, p.sourceUpdatedAt, p.capturedAt, p.observationKey]
    );
  }

  private async upsertSet(tx: Exec, s: CatalogSetRow): Promise<void> {
    await tx.run(
      `INSERT INTO catalog_sets (language, id, name, name_search, series, status, release_date, official_count, total_count, logo_url, symbol_url, raw_json, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (language, id) DO UPDATE SET name = excluded.name, name_search = excluded.name_search, series = excluded.series, status = excluded.status,
         release_date = excluded.release_date, official_count = excluded.official_count, total_count = excluded.total_count, logo_url = excluded.logo_url,
         symbol_url = excluded.symbol_url, raw_json = excluded.raw_json, synced_at = excluded.synced_at`,
      [s.language, s.id, s.name, s.nameSearch, s.series, s.status, s.releaseDate, s.officialCount, s.totalCount, s.logoUrl, s.symbolUrl, s.rawJson, s.syncedAt]
    );
  }

  /** card -> variants -> prices of one card; variants and prices are REPLACED for that card (a refresh is authoritative for the card). */
  private async upsertCard(tx: Exec, m: MappedCard): Promise<void> {
    const c = m.card;
    await tx.run(
      `INSERT INTO catalog_cards (language, id, set_id, local_id, local_id_sort, name, name_search, rarity, category, illustrator, image_url, has_normal, has_holo,
         has_reverse, has_first_edition, w_promo, available_variants_json, raw_json, synced_at, detail_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (language, id) DO UPDATE SET set_id = excluded.set_id, local_id = excluded.local_id, local_id_sort = excluded.local_id_sort, name = excluded.name,
         name_search = excluded.name_search, rarity = excluded.rarity, category = excluded.category, illustrator = excluded.illustrator, image_url = excluded.image_url,
         has_normal = excluded.has_normal, has_holo = excluded.has_holo, has_reverse = excluded.has_reverse, has_first_edition = excluded.has_first_edition,
         w_promo = excluded.w_promo, available_variants_json = excluded.available_variants_json, raw_json = excluded.raw_json, synced_at = excluded.synced_at,
         detail_synced_at = excluded.detail_synced_at`,
      [c.language, c.id, c.setId, c.localId, c.localIdSort, c.name, c.nameSearch, c.rarity, c.category, c.illustrator, c.imageUrl, c.hasNormal ? 1 : 0, c.hasHolo ? 1 : 0,
        c.hasReverse ? 1 : 0, c.hasFirstEdition ? 1 : 0, c.wPromo ? 1 : 0, c.availableVariantsJson, c.rawJson, c.syncedAt, c.detailSyncedAt]
    );
    await tx.run('DELETE FROM catalog_variants WHERE language = ? AND card_id = ?', [c.language, c.id]);
    for (const v of m.variants) {
      await tx.run(
        `INSERT INTO catalog_variants (language, card_id, variant_key, variant, variant_detail, provider_variant_id, type, subtype, foil, size, stamps_json, attributes_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [v.language, v.cardId, v.variantKey, v.variant, v.variantDetail, v.providerVariantId, v.type, v.subtype, v.foil, v.size, v.stampsJson, v.attributesJson]
      );
    }
    await tx.run('DELETE FROM catalog_latest_prices WHERE language = ? AND catalog_card_id = ?', [c.language, c.id]);
    for (const p of m.prices) await this.upsertPrice(tx, p);
  }

  /* ------------------------------------------------------------------------------------------ refresh / incremental discovery */
  /** Fetch + map the set detail; freeze its card manifest into the checkpoint. false = the set could not be fetched (counted as a failed set). */
  private async loadSetManifest(cp: Checkpoint, set: SetState): Promise<boolean> {
    const url = `${this.opts.apiBase}/${set.language}/sets/${encodeIdForPath(set.setId)}`;
    const res = await this.fetchJson<RawSetDetail>(url, (b): b is RawSetDetail => isRecord(b) && b.id === set.setId && typeof b.name === 'string');
    if (!res.ok) {
      set.status = 'failed';
      set.cardsFailed = 0;
      this.warn(cp, { code: res.code === 'NOT_FOUND' ? 'SET_NOT_FOUND' : res.code, language: set.language, cardId: null, message: 'The set could not be fetched' });
      return false;
    }
    const row = mapSet(res.body, { language: set.language, syncedAt: this.ctx.env.clock.now() });
    const ids = [...new Set((Array.isArray(res.body.cards) ? res.body.cards : []).map((c) => c.id).filter((x): x is string => typeof x === 'string'))];
    set.setRow = row;
    set.setApplied = false;
    set.manifestFetched = true;
    set.checkedAt = row.syncedAt;
    set.advertisedTotal = row.totalCount;
    set.cards = ids.map((cardId) => ({ id: cardId, status: 'pending', errorCode: null }));
    set.cardsTotal = ids.length;
    set.cardsDone = 0;
    set.cardsFailed = 0;
    return true;
  }

  /** incremental: frozen discovery of what needs refreshing (see header). */
  private async discover(id: string, token: string, cp: Checkpoint): Promise<void> {
    const wanted = cp.selection.scope === 'followed' ? new Set(cp.selection.sets.map((s) => `${s.language}\u0000${s.setId}`)) : null;
    const states: SetState[] = [];
    for (const language of cp.languages) {
      const catalog = await this.ctx.databases.catalog(language);
      if (!catalog) {
        this.warn(cp, { code: 'CATALOG_NOT_INSTALLED', language, cardId: null, message: `The ${language} catalog is not installed, so it was skipped` });
        continue;
      }
      const list = await this.fetchJson<Array<Record<string, unknown>>>(`${this.opts.apiBase}/${language}/sets`, (b): b is Array<Record<string, unknown>> => Array.isArray(b));
      if (!list.ok) throw new CatalogError(list.code, 'The set list could not be fetched');
      const known = new Map<string, { name: string; status: string; official: number | null; total: number | null }>();
      for (const r of await catalog.rows('SELECT id, name, status, official_count, total_count FROM catalog_sets WHERE language = ?', [language])) {
        known.set(String(r[0]), { name: String(r[1]), status: String(r[2]), official: r[3] === null ? null : Number(r[3]), total: r[4] === null ? null : Number(r[4]) });
      }
      const seen = new Set<string>();
      for (const brief of list.body) {
        const setId = typeof brief.id === 'string' ? brief.id : null;
        if (!setId || seen.has(setId)) continue;
        seen.add(setId);
        if (wanted && !wanted.has(`${language}\u0000${setId}`)) continue;
        const k = known.get(setId);
        const counts = isRecord(brief.cardCount) ? brief.cardCount : {};
        const total = typeof counts.total === 'number' ? counts.total : null;
        const official = typeof counts.official === 'number' ? counts.official : null;
        const changed = !k || k.status === 'unpublished' || brief.name !== k.name || (total !== null && total !== k.total) || (official !== null && official !== k.official);
        states.push({
          language, setId, status: changed ? 'pending' : 'done', manifestFetched: !changed, detailEtag: null, checkedAt: this.ctx.env.clock.now(), advertisedTotal: total,
          cardsTotal: changed ? null : 0, cardsDone: 0, cardsFailed: 0, cards: [], setRow: null, setApplied: !changed
        });
      }
    }
    states.sort((a, b) => a.language.localeCompare(b.language) || a.setId.localeCompare(b.setId));
    cp.sets = states;
    cp.discovered = true;
    await this.persist(id, token, cp, []);
  }

  /* ------------------------------------------------------------------------------------------ network */
  private async fetchBatch(set: SetKey, batch: CardState[], mode: SyncDto['mode']): Promise<FetchedCard[]> {
    const out: FetchedCard[] = new Array(batch.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = next++;
        if (index >= batch.length) return;
        const card = batch[index] as CardState;
        out[index] = await this.fetchCard(set.language, card.id, mode);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency, batch.length) }, worker));
    return out;
  }

  private async fetchCard(language: Language, id: string, _mode: SyncDto['mode']): Promise<FetchedCard> {
    void _mode;
    const url = `${this.opts.apiBase}/${language}/cards/${encodeIdForPath(id)}`;
    const res = await this.fetchJson<RawCard>(url, (b): b is RawCard => isRecord(b) && b.id === id && isRecord(b.set));
    if (!res.ok) return { id, ok: false, code: res.code };
    try {
      const mapped = mapCard(res.body, { language, syncedAt: this.ctx.env.clock.now() });
      return { id, ok: true, payloadHash: sha256Hex(JSON.stringify(res.body)), prices: mapped.prices, mapped, warnings: mapped.warnings };
    } catch {
      return { id, ok: false, code: 'BAD_PAYLOAD' };
    }
  }

  /** GET with retry/backoff/Retry-After (shared pause). `validate` failing on a 200 = BAD_PAYLOAD and is retried (a proxy can serve a truncated body once). */
  private async fetchJson<T>(url: string, validate: (body: unknown) => body is T): Promise<FetchResult<T>> {
    let code = 'HTTP_FAILED';
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt += 1) {
      const wait = this.pauseUntil - Date.now();
      if (wait > 0) await this.opts.sleep(wait);
      let retryDelay = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (attempt - 1));
      try {
        const res = await this.platform.http({ url, method: 'GET', headers: { accept: 'application/json' }, timeoutMs: this.opts.timeoutMs });
        if (res.status === 200) {
          if (validate(res.body)) return { ok: true, body: res.body };
          code = 'BAD_PAYLOAD';
        } else if (res.status === 429 || res.status >= 500) {
          code = res.status === 429 ? 'RATE_LIMITED' : 'SERVER_ERROR';
          const retryAfter = parseRetryAfter(res.headers['retry-after'], Date.now());
          if (retryAfter !== null) {
            retryDelay = Math.min(this.opts.maxDelayMs, retryAfter);
            this.pauseUntil = Math.max(this.pauseUntil, Date.now() + retryDelay); // every worker waits, not just this one
          }
        } else if (res.status === 404) {
          return { ok: false, code: 'NOT_FOUND' };
        } else {
          return { ok: false, code: `HTTP_${res.status}` };
        }
      } catch {
        code = 'HTTP_FAILED'; // timeout / offline
      }
      if (attempt < this.opts.maxAttempts) await this.opts.sleep(retryDelay);
    }
    return { ok: false, code };
  }
}

type FetchedCard =
  | { id: string; ok: true; payloadHash: string; prices: CatalogLatestPriceRow[]; mapped: MappedCard; warnings: Array<{ code: string; cardId: string | null; message: string }> }
  | { id: string; ok: false; code: string };
