/**
 * DEV-only browser harness (Playwright: `await page.goto('/harness.html'); page.evaluate(() => import('/src/platform/pwa/harness.ts').then(m => m.run(...)))`).
 * Runs the REAL ledger engine + image handler against REAL Cache Storage, REAL IndexedDB and the REAL Web Lock in a window,
 * with a tiny byte limit and synthetic responses served by Playwright's `page.route('https://assets.tcgdex.net/**')`.
 * The real service worker can only be exercised in a production build (shell-f owns that e2e).
 *
 * URL grammar understood by the spec's route mock:  https://assets.tcgdex.net/t/<kind>/<bytes>/<id>/low.webp
 *   kind: ok (200 image/webp + CORS) | missing (404) | html (200 text/html) | nocors (200 image without ACAO) | slow (ok after 30 ms)
 */
import { createImageEngine } from './image-cache/engine';
import { createImageHandler } from './image-cache/handler';
import { createCacheStorageAdapter, createIdbLedger, createWebLock } from './image-cache/idb-ledger';
import type { LedgerEntry, LedgerStore } from './image-cache/types';

export interface HarnessOptions {
  limit: number;
  perEntryMax: number;
  entryBytes: number;
}

const artUrl = (kind: string, bytes: number, id: string | number) => `https://assets.tcgdex.net/t/${kind}/${bytes}/${id}/low.webp`;

export async function run(options: HarnessOptions): Promise<Record<string, unknown>> {
  const { limit, perEntryMax, entryBytes } = options;
  const suffix = Math.random().toString(36).slice(2, 8);
  const cacheName = `fdx-harness-images-${suffix}`;
  const dbName = `fdx-harness-ledger-${suffix}`;
  const results: Record<string, unknown> = {};

  const cache = createCacheStorageAdapter(cacheName);
  const realLedger = createIdbLedger(dbName);

  // Shadow-check the invariant at EVERY durable ledger write against the real store.
  const shadow = new Map<string, LedgerEntry>();
  let peak = 0;
  let writes = 0;
  const checked: LedgerStore = {
    loadAll: () => realLedger.loadAll(),
    async putEntry(entry) {
      const next = new Map(shadow).set(entry.url, entry);
      const sum = [...next.values()].reduce((a, e) => a + e.bytes, 0);
      peak = Math.max(peak, sum);
      writes += 1;
      if (sum > limit) throw new Error(`INVARIANT: ledger sum ${sum} > limit ${limit}`);
      await realLedger.putEntry(entry);
      shadow.set(entry.url, entry);
    },
    async deleteEntry(url) {
      await realLedger.deleteEntry(url);
      shadow.delete(url);
    },
    async clearEntries() {
      await realLedger.clearEntries();
      shadow.clear();
    },
    setLimit: (b) => realLedger.setLimit(b)
  };

  const limits = { min: 1, default: limit, max: limit * 10, perEntryMax };
  const lock = createWebLock(`fdx-harness-lock-${suffix}`);
  const engine = createImageEngine({ cache, store: checked, lock, limits, touchDebounceMs: 5 });
  const handler = createImageHandler({ engine, perEntryMax });

  const view = async (url: string) => {
    const waits: Promise<unknown>[] = [];
    const response = await handler.handle(new Request(url, { mode: 'no-cors' }), (p) => waits.push(p));
    await Promise.all(waits);
    return response;
  };
  const realCacheKeys = async () => (await (await caches.open(cacheName)).keys()).map((r) => r.url);
  const realRows = async () => (await realLedger.loadAll()).entries;
  const sum = (rows: LedgerEntry[]) => rows.reduce((a, r) => a + r.bytes, 0);

  try {
    // 1. sequential views past the cap
    for (let i = 0; i < 12; i++) await view(artUrl('ok', entryBytes, i));
    {
      const rows = await realRows();
      const keys = await realCacheKeys();
      results.sequential = { rows: rows.length, keys: keys.length, sum: sum(rows), allCommitted: rows.every((r) => r.state === 'committed'), keysMatchRows: JSON.stringify([...keys].sort()) === JSON.stringify(rows.map((r) => r.url).sort()), expectedMax: Math.floor(limit / entryBytes) };
    }

    // 2. recency: touch the oldest survivor, admit one more, the touched one must survive
    {
      const rows = (await realRows()).sort((a, b) => a.lastAccess - b.lastAccess);
      const oldest = rows[0]!.url;
      const second = rows[1]!.url;
      await view(oldest); // cache hit -> touch
      await new Promise((r) => setTimeout(r, 40)); // debounce flush
      await view(artUrl('ok', entryBytes, 100));
      const keys = await realCacheKeys();
      results.lru = { touchedSurvived: keys.includes(oldest), nextOldestEvicted: !keys.includes(second) };
    }

    // 3. concurrent admissions
    await Promise.all(Array.from({ length: 30 }, (_, i) => view(artUrl('slow', entryBytes, 200 + i))));
    {
      const rows = await realRows();
      results.concurrent = { sum: sum(rows), peak, writes, keys: (await realCacheKeys()).length, allCommitted: rows.every((r) => r.state === 'committed') };
    }

    // 4. bypass cases never reach the stores
    {
      const before = (await realRows()).length;
      const statuses: Record<string, string> = {};
      for (const [kind, bytes] of [['missing', 50], ['html', 50], ['ok', perEntryMax + 1]] as const) {
        const r = await view(artUrl(kind, bytes, `bypass-${kind}`));
        statuses[kind] = String(r.status);
      }
      let noCors = 'resolved';
      const r = await view(artUrl('nocors', 50, 'bypass-nocors'));
      noCors = r.type;
      const rows = await realRows();
      const keys = await realCacheKeys();
      results.bypass = { statuses, noCors, rowsDelta: rows.length - before, leaked: keys.filter((k) => k.includes('bypass-')).length };
    }

    // 5. restart reconciliation on real stores: orphan bytes, abandoned pending reservation, metadata without bytes
    {
      const c = await caches.open(cacheName);
      const rows = await realRows();
      const victim = rows[0]!;
      await c.put(artUrl('ok', 10, 'orphan'), new Response(new Uint8Array(10), { headers: { 'content-type': 'image/webp' } }));
      await c.put(artUrl('ok', 10, 'pending'), new Response(new Uint8Array(10), { headers: { 'content-type': 'image/webp' } }));
      await realLedger.putEntry({ url: artUrl('ok', 10, 'pending'), bytes: 10, lastAccess: 1, storedAt: 1, state: 'pending' });
      await c.delete(victim.url); // committed row now has no bytes
      const ledger2 = createIdbLedger(dbName); // a "restarted worker": fresh connection, fresh engine, fresh in-memory state
      const engine2 = createImageEngine({ cache, store: ledger2, lock, limits });
      const stats = await engine2.stats();
      const rows2 = (await ledger2.loadAll()).entries;
      const keys2 = await realCacheKeys();
      results.reconcile = {
        enforced: stats.enforced,
        reserved: stats.reservedBytes,
        orphanGone: !keys2.some((k) => k.includes('/orphan/')),
        pendingGone: !keys2.some((k) => k.includes('/pending/')) && !rows2.some((r) => r.url.includes('/pending/')),
        victimRowDropped: !rows2.some((r) => r.url === victim.url),
        consistent: JSON.stringify([...keys2].sort()) === JSON.stringify(rows2.map((r) => r.url).sort()),
        sumMatchesStats: sum(rows2) === stats.committedBytes
      };
      await ledger2.close();
    }

    // 6. limit shrink evicts before the ack; clear empties everything
    {
      const shrunk = await engine.setLimit(entryBytes * 2);
      const rows = await realRows();
      const keys = await realCacheKeys();
      results.shrink = { limit: shrunk.limitBytes, committed: shrunk.committedBytes, rowSum: sum(rows), keys: keys.length, persistedLimit: (await realLedger.loadAll()).limit };
      const cleared = await engine.clear();
      results.clear = { entries: cleared.entries, committed: cleared.committedBytes, keys: (await realCacheKeys()).length, rows: (await realRows()).length };
    }
    results.error = null;
  } catch (error) {
    results.error = error instanceof Error ? error.message : String(error);
  } finally {
    await caches.delete(cacheName);
    await realLedger.close();
    indexedDB.deleteDatabase(dbName);
  }
  return results;
}
