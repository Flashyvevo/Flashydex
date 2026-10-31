import { ById, PageQuery, SyncStart, type Input, type Language, type Page, type SyncDto } from '@flashydex/schemas';
import { encodeIdForPath, mapCard, type CatalogLatestPriceRow, type RawCard } from '../catalog/tcgdex';
import { chunk, placeholders } from '../db/sql';
import { ActiveWorkError, DomainError, InvalidStateError, NotFoundError, UnsupportedCapabilityError, toDomainError } from '../errors';
import type { Platform } from '../platform/platform';
import { parse, type ServiceContext } from './context';

/**
 * SyncService (Phase 1): `prices_only` over a frozen `followed` selection (API.md SyncService, DATA-MODEL checkpoint v3).
 *
 *  - Owned identities only: the card list of every selected set is the distinct owned catalog ids of that set, frozen at start.
 *  - Network: `Platform.http` GET `https://api.tcgdex.net/v2/{lang}/cards/{id}`; at most `concurrency` (<= 8) requests in flight;
 *    429/5xx/timeout/bad-JSON retry with exponential backoff, honouring `Retry-After` (shared pause for every worker).
 *    A unit that still fails after the attempts is counted in `cardsFailed`; it never aborts the rest.
 *  - Writes: per batch of <= 25 cards: (1) catalog DB `catalog_latest_prices` upsert, then (2) user DB `price_snapshots`
 *    (INSERT OR IGNORE by observation key) + fenced checkpoint/counters. A kill between (1) and (2) re-fetches that batch on
 *    resume; both writes are idempotent, so there is no cross-file atomicity claim. No staged payload file in Phase 1.
 *  - Never touches owned_cards, settings, custom cards or catalog card metadata.
 *  - `refresh` and `incremental` need the full catalog writer and are NOT implemented: they throw UNSUPPORTED_CAPABILITY.
 */
type SetKey = { language: Language; setId: string };
type CardState = { id: string; status: 'pending' | 'done' | 'failed'; errorCode: string | null };
type SetState = SetKey & {
  status: 'pending' | 'running' | 'done' | 'failed' | 'unpublished';
  manifestFetched: boolean; detailEtag: string | null; checkedAt: string | null; advertisedTotal: number | null;
  cardsTotal: number | null; cardsDone: number; cardsFailed: number; cards: CardState[];
};
type Warning = { code: string; language: Language; cardId: string | null; message: string };
type Checkpoint = {
  version: 3; languages: Language[]; selection: SyncDto['selection'];
  catalogGenerations: Array<{ language: Language; generation: number }>; pendingBatch: null;
  lists: never[]; sets: SetState[]; warnings: Warning[];
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
}

export type SyncCapabilities = { pricesOnly: boolean; refresh: boolean; reason: string | null };

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

export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export class SyncService {
  private readonly opts: Required<Omit<SyncOptions, 'awaitRun'>> & { awaitRun: boolean };
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
      apiBase: options.apiBase ?? 'https://api.tcgdex.net/v2'
    };
  }

  private get user() {
    return this.ctx.databases.user;
  }

  /** What this platform can do. Honest: the UI disables what is false. */
  capabilities(): SyncCapabilities {
    if (!this.ctx.databases.canWriteCatalog) {
      return { pricesOnly: false, refresh: false, reason: 'Price updates need a writable catalog, which this build doesn’t have.' };
    }
    return { pricesOnly: true, refresh: false, reason: null };
  }

  /** Resolves when the in-flight background run (if any) is finished. For tests and graceful shutdown. */
  idle(): Promise<void> {
    return this.active ?? Promise.resolve();
  }

  /* ------------------------------------------------------------------------------------------ API */
  async start(input: Input<typeof SyncStart>): Promise<SyncDto> {
    const request = parse(SyncStart, input);
    if (request.mode !== 'prices_only') {
      throw new UnsupportedCapabilityError(request.mode === 'refresh' ? 'Refreshing a set isn’t available yet.' : 'Catalog sync isn’t available yet.');
    }
    if (!this.capabilities().pricesOnly) throw new UnsupportedCapabilityError(this.capabilities().reason ?? 'Price updates are not available');
    if (!request.selection || request.selection.scope !== 'followed') throw new UnsupportedCapabilityError('Price updates need a list of sets');
    const seen = new Set<string>();
    const sets = request.selection.sets.filter((s) => (seen.has(`${s.language}\u0000${s.setId}`) ? false : (seen.add(`${s.language}\u0000${s.setId}`), true)));
    const languages = [...new Set(sets.map((s) => s.language))].sort() as Language[];

    // Frozen manifest = distinct OWNED catalog ids per selected set.
    const states: SetState[] = [];
    for (const key of sets) {
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
    const checkpoint: Checkpoint = {
      version: 3, languages, selection: { scope: 'followed', sets }, catalogGenerations: languages.map((language) => ({ language, generation: this.ctx.databases.generation(language) })),
      pendingBatch: null, lists: [], sets: states, warnings: []
    };
    const cardsTotal = states.reduce((n, s) => n + (s.cardsTotal ?? 0), 0);
    const id = this.ctx.env.ids.uuid();
    const token = this.ctx.env.ids.uuid();
    const now = this.ctx.env.clock.now();

    await this.user.transaction(async (tx) => {
      const busy = await tx.rows("SELECT 1 FROM sync_state WHERE lock_key IS NOT NULL UNION ALL SELECT 1 FROM catalog_install_jobs WHERE lock_key IS NOT NULL LIMIT 1");
      if (busy.length > 0) throw new ActiveWorkError('ACTIVE_SYNC', 'A download or price update is already running');
      await tx.run(
        `INSERT INTO sync_state (id, status, mode, languages_json, selection_json, lock_key, worker_token, attempt, sets_total, sets_done, cards_total, cards_done,
           cards_failed, checkpoint_json, last_error_json, heartbeat_at, lease_expires_at, started_at, finished_at, created_at, updated_at)
         VALUES (?, 'queued', 'prices_only', ?, ?, 'catalog', ?, 1, ?, ?, ?, 0, 0, ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
        [id, JSON.stringify(languages), JSON.stringify(checkpoint.selection), token, states.length, states.filter((s) => s.status === 'done').length, cardsTotal,
          JSON.stringify(checkpoint), now, now, now]
      );
    });
    this.launch(id, token);
    if (this.opts.awaitRun) await this.idle();
    return this.get({ id });
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
    if (!this.capabilities().pricesOnly) throw new UnsupportedCapabilityError(this.capabilities().reason ?? 'Price updates are not available');
    const cp = this.readCheckpoint(row);
    if (!cp) throw new InvalidStateError('This update can’t be resumed; start a new one');
    for (const s of cp.sets) {
      for (const c of s.cards) if (c.status === 'failed') { c.status = 'pending'; c.errorCode = null; }
      s.cardsFailed = 0;
      if (s.status === 'failed' || s.status === 'running') s.status = 'pending';
    }
    const token = this.ctx.env.ids.uuid();
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      const busy = await tx.rows("SELECT 1 FROM sync_state WHERE lock_key IS NOT NULL UNION ALL SELECT 1 FROM catalog_install_jobs WHERE lock_key IS NOT NULL LIMIT 1");
      if (busy.length > 0) throw new ActiveWorkError('ACTIVE_SYNC', 'A download or price update is already running');
      await tx.run(
        `UPDATE sync_state SET status = 'queued', lock_key = 'catalog', worker_token = ?, attempt = attempt + 1, checkpoint_json = ?, cards_failed = 0,
           sets_done = ?, last_error_json = NULL, finished_at = NULL, heartbeat_at = ?, updated_at = ? WHERE id = ?`,
        [token, JSON.stringify(cp), cp.sets.filter((s) => s.status === 'done' || s.status === 'unpublished').length, now, now, id]
      );
    });
    this.launch(id, token);
    if (this.opts.awaitRun) await this.idle();
    return this.get({ id });
  }

  /** Boot recovery: a run that was active when the app died becomes `interrupted` (resumable) and releases the lock. */
  async recover(): Promise<{ interrupted: number }> {
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
  private launch(id: string, token: string): void {
    const run = this.run(id, token).catch(() => undefined);
    this.active = run.finally(() => { if (this.active === run) this.active = null; });
  }

  private async row(id: string): Promise<SyncRow | null> {
    return (await this.user.select<SyncRow>(SYNC_COLS, 'FROM sync_state WHERE id = ?', [id]))[0] ?? null;
  }

  private readCheckpoint(row: SyncRow): Checkpoint | null {
    try {
      const cp = JSON.parse(row.checkpointJson) as Checkpoint;
      return cp.version === 3 && Array.isArray(cp.sets) ? cp : null;
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

  private async run(id: string, token: string): Promise<void> {
    this.pauseUntil = 0;
    try {
      const startedAt = this.ctx.env.clock.now();
      await this.user.run("UPDATE sync_state SET status = 'running', started_at = COALESCE(started_at, ?), heartbeat_at = ?, updated_at = ? WHERE id = ? AND worker_token = ? AND status = 'queued'", [startedAt, startedAt, startedAt, id, token]);
      const row = await this.row(id);
      const cp = row ? this.readCheckpoint(row) : null;
      if (!row || !cp) throw new InvalidStateError('The update state is unreadable');

      for (const set of cp.sets) {
        if (set.status === 'done' || set.status === 'unpublished') continue;
        set.status = 'running';
        const pending = set.cards.filter((c) => c.status !== 'done');
        for (const batch of chunk(pending, this.opts.batchSize)) {
          const current = await this.row(id);
          if (!current || current.status === 'cancel_requested') {
            await this.persist(id, token, cp, []);
            await this.finish(id, token, 'cancelled', null);
            return;
          }
          const results = await this.fetchBatch(set, batch);
          const rows: Array<{ card: string; prices: CatalogLatestPriceRow[] }> = [];
          const ok: string[] = [];
          for (const r of results) {
            const card = set.cards.find((c) => c.id === r.id) as CardState;
            if (r.ok) {
              ok.push(r.id);
              rows.push({ card: r.id, prices: r.prices });
              for (const w of r.warnings) this.warn(cp, { code: w.code, language: set.language, cardId: w.cardId, message: w.message });
            } else {
              card.status = 'failed';
              card.errorCode = r.code;
            }
          }
          // (1) catalog commit
          const written = await this.writeCatalog(set.language, rows);
          for (const id2 of ok) {
            const card = set.cards.find((c) => c.id === id2) as CardState;
            if (written.missing.has(id2)) {
              card.status = 'failed';
              card.errorCode = 'NOT_IN_CATALOG';
              this.warn(cp, { code: 'NOT_IN_CATALOG', language: set.language, cardId: id2, message: 'This card is no longer in the installed catalog' });
            } else {
              card.status = 'done';
              card.errorCode = null;
            }
          }
          set.cardsDone = set.cards.filter((c) => c.status === 'done').length;
          set.cardsFailed = set.cards.filter((c) => c.status === 'failed').length;
          // (2) user commit: history for owned identities + fenced checkpoint
          await this.persist(id, token, cp, rows.filter((r) => !written.missing.has(r.card)).map((r) => ({ language: set.language, prices: r.prices })));
        }
        set.status = set.cardsFailed > 0 ? 'failed' : 'done';
        await this.persist(id, token, cp, []);
      }
      const failed = cp.sets.reduce((n, s) => n + s.cardsFailed, 0);
      await this.finish(id, token, failed > 0 ? 'failed' : 'completed', failed > 0 ? { code: 'PARTIAL_FAILURE', message: `${failed} card${failed === 1 ? '' : 's'} could not be updated` } : null);
    } catch (error) {
      if (error instanceof Fenced) return; // a newer attempt owns the run
      const domain = error instanceof DomainError ? error : toDomainError(error);
      await this.finish(id, token, 'failed', { code: domain.code, message: domain.message }).catch(() => undefined);
    }
  }

  private warn(cp: Checkpoint, w: Warning): void {
    if (cp.warnings.length < MAX_WARNINGS) cp.warnings.push({ ...w, message: w.message.slice(0, 200) });
  }

  /** Fenced progress commit; `prices` become personal history (idempotent by observation key). */
  private async persist(id: string, token: string, cp: Checkpoint, batches: Array<{ language: Language; prices: CatalogLatestPriceRow[] }>): Promise<void> {
    const now = this.ctx.env.clock.now();
    const cardsDone = cp.sets.reduce((n, s) => n + s.cardsDone, 0);
    const cardsFailed = cp.sets.reduce((n, s) => n + s.cardsFailed, 0);
    const setsDone = cp.sets.filter((s) => s.status === 'done' || s.status === 'unpublished').length;
    await this.user.transaction(async (tx) => {
      const r = await tx.rows('SELECT worker_token FROM sync_state WHERE id = ?', [id]);
      if (r[0]?.[0] !== token) throw new Fenced();
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
        `UPDATE sync_state SET checkpoint_json = ?, sets_done = ?, cards_done = ?, cards_failed = ?, heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ?`,
        [JSON.stringify(cp), setsDone, cardsDone, cardsFailed, now, new Date(Date.parse(now) + 60_000).toISOString(), now, id]
      );
    });
  }

  /** Upsert quotes into the catalog's `catalog_latest_prices` for cards that exist in it; never touches card metadata. */
  private async writeCatalog(language: Language, rows: Array<{ card: string; prices: CatalogLatestPriceRow[] }>): Promise<{ missing: Set<string> }> {
    const missing = new Set<string>();
    if (rows.length === 0) return { missing };
    const result = await this.ctx.databases.withWritableCatalog(language, async (db) => {
      const ids = rows.map((r) => r.card);
      const existing = new Set<string>();
      for (const part of chunk(ids, 100)) {
        for (const r of await db.rows(`SELECT id FROM catalog_cards WHERE language = ? AND id IN (${placeholders(part.length)})`, [language, ...part])) existing.add(String(r[0]));
      }
      await db.transaction(async (tx) => {
        for (const entry of rows) {
          if (!existing.has(entry.card)) { missing.add(entry.card); continue; }
          for (const p of entry.prices) {
            await tx.run(
              `INSERT OR REPLACE INTO catalog_latest_prices (id, catalog_card_id, language, source, variant, variant_detail, provider_variant_key, currency,
                 low_cents, mid_cents, high_cents, market_cents, trend_cents, source_updated_at, captured_at, observation_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [p.observationKey, p.catalogCardId, p.language, p.source, p.variant, p.variantDetail, p.providerVariantKey, p.currency, p.lowCents, p.midCents, p.highCents,
                p.marketCents, p.trendCents, p.sourceUpdatedAt, p.capturedAt, p.observationKey]
            );
          }
        }
      });
      return true;
    });
    if (result === null) for (const r of rows) missing.add(r.card); // catalog vanished: nothing was written
    return { missing };
  }

  private async fetchBatch(set: SetKey, batch: CardState[]): Promise<Array<
    { id: string; ok: true; prices: CatalogLatestPriceRow[]; warnings: Array<{ code: string; cardId: string | null; message: string }> } | { id: string; ok: false; code: string }
  >> {
    const out: Array<Awaited<ReturnType<SyncService['fetchBatch']>>[number]> = new Array(batch.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = next++;
        if (index >= batch.length) return;
        const card = batch[index] as CardState;
        out[index] = await this.fetchCard(set.language, card.id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency, batch.length) }, worker));
    return out;
  }

  private async fetchCard(language: Language, id: string): Promise<Awaited<ReturnType<SyncService['fetchBatch']>>[number]> {
    const url = `${this.opts.apiBase}/${language}/cards/${encodeIdForPath(id)}`;
    let code = 'HTTP_FAILED';
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt += 1) {
      const wait = this.pauseUntil - Date.now();
      if (wait > 0) await this.opts.sleep(wait);
      let retryDelay = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (attempt - 1));
      try {
        const res = await this.platform.http({ url, method: 'GET', headers: { accept: 'application/json' }, timeoutMs: this.opts.timeoutMs });
        if (res.status === 200) {
          if (isRecord(res.body) && res.body.id === id && isRecord(res.body.set)) {
            try {
              const mapped = mapCard(res.body as unknown as RawCard, { language, syncedAt: this.ctx.env.clock.now() });
              return { id, ok: true, prices: mapped.prices, warnings: mapped.warnings };
            } catch {
              return { id, ok: false, code: 'BAD_PAYLOAD' };
            }
          }
          code = 'BAD_PAYLOAD'; // null body = unparsable JSON; wrong shape/id = not this card. Retry: a proxy can serve a truncated body once.
        } else if (res.status === 429 || res.status >= 500) {
          code = res.status === 429 ? 'RATE_LIMITED' : 'SERVER_ERROR';
          const retryAfter = parseRetryAfter(res.headers['retry-after'], Date.now());
          if (retryAfter !== null) {
            retryDelay = Math.min(this.opts.maxDelayMs, retryAfter);
            this.pauseUntil = Math.max(this.pauseUntil, Date.now() + retryDelay); // every worker waits, not just this one
          }
        } else if (res.status === 404) {
          return { id, ok: false, code: 'NOT_FOUND' };
        } else {
          return { id, ok: false, code: `HTTP_${res.status}` };
        }
      } catch {
        code = 'HTTP_FAILED'; // timeout / offline
      }
      if (attempt < this.opts.maxAttempts) await this.opts.sleep(retryDelay);
    }
    return { id, ok: false, code };
  }
}
