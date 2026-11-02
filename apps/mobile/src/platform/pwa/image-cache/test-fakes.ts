import type { CacheLike, LedgerEntry, LedgerStore, LockLike } from './types';

/** In-memory fakes for the engine tests (no jsdom, no real storage). Type-checked as part of src; imported by tests only. */
export interface FaultPlan {
  /** Process dies at this step of the NEXT admission; afterwards every operation rejects until `dead` is reset. */
  crashAt?: 'reserve' | 'put' | 'commit' | undefined;
  dead?: boolean;
  /** The next N cache.put calls throw QuotaExceededError. */
  quotaOnPuts?: number;
  putCalls?: number;
}

export function bytesOf(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(n).fill(7);
}

function die(plan: FaultPlan): never {
  plan.dead = true;
  throw new Error('process died');
}
function ensureAlive(plan: FaultPlan) {
  if (plan.dead) throw new Error('process is dead');
}
const tick = () => new Promise<void>((r) => setImmediate(r));

export function createFakeCache(plan: FaultPlan): CacheLike & { map: Map<string, Response> } {
  const map = new Map<string, Response>();
  return {
    map,
    async has(url) {
      ensureAlive(plan);
      await tick();
      return map.has(url);
    },
    async match(url) {
      ensureAlive(plan);
      await tick();
      return map.get(url)?.clone();
    },
    async put(url, response) {
      ensureAlive(plan);
      plan.putCalls = (plan.putCalls ?? 0) + 1;
      await tick();
      if ((plan.quotaOnPuts ?? 0) > 0) {
        plan.quotaOnPuts = (plan.quotaOnPuts ?? 0) - 1;
        throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      }
      map.set(url, response);
      if (plan.crashAt === 'put') die(plan); // bytes landed, process died before the ledger commit
    },
    async delete(url) {
      ensureAlive(plan);
      await tick();
      return map.delete(url);
    },
    async keys() {
      ensureAlive(plan);
      await tick();
      return [...map.keys()];
    }
  };
}

export function createFakeStore(plan: FaultPlan): LedgerStore & {
  rows: Map<string, LedgerEntry>;
  limit: number | null;
  peak: number;
  onWrite?: (entriesAfter: LedgerEntry[]) => void;
} {
  const store = {
    rows: new Map<string, LedgerEntry>(),
    limit: null as number | null,
    peak: 0,
    onWrite: undefined as ((entriesAfter: LedgerEntry[]) => void) | undefined,
    async loadAll() {
      ensureAlive(plan);
      await tick();
      return { entries: [...store.rows.values()].map((e) => ({ ...e })), limit: store.limit };
    },
    async putEntry(entry: LedgerEntry) {
      ensureAlive(plan);
      await tick();
      if (plan.crashAt === 'reserve' && entry.state === 'pending') die(plan);
      if (plan.crashAt === 'commit' && entry.state === 'committed') die(plan);
      const after = new Map(store.rows);
      after.set(entry.url, { ...entry });
      const list = [...after.values()];
      store.onWrite?.(list);
      store.peak = Math.max(store.peak, list.reduce((a, e) => a + e.bytes, 0));
      store.rows.set(entry.url, { ...entry });
    },
    async deleteEntry(url: string) {
      ensureAlive(plan);
      await tick();
      store.rows.delete(url);
    },
    async clearEntries() {
      ensureAlive(plan);
      await tick();
      store.rows.clear();
    },
    async setLimit(bytes: number) {
      ensureAlive(plan);
      await tick();
      store.limit = bytes;
    }
  };
  return store;
}

/** Plain promise-chain lock (the SW-local queue); the engine adds its own on top. */
export function plainLock(): LockLike {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = tail.then(fn, fn);
      tail = next.catch(() => undefined);
      return next;
    }
  };
}
