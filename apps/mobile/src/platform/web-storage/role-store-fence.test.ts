import { describe, expect, it } from 'vitest';
import { createIdbStateCell, createRoleStoreFromCell } from './role-store';
import { isRetiredError } from './write-gate';

/**
 * S8-01 item 3: the fence is checked INSIDE the IndexedDB transaction, at execution time. A tiny fake IndexedDB: one `meta` store, a
 * readwrite request that is queued behind a held "fixture" transaction (`hold`), commit on a microtask after the request callback.
 */
function fakeIndexedDb() {
  const state = { value: undefined as unknown, puts: 0, hold: Promise.resolve() as Promise<void> };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => undefined,
    close: () => undefined,
    onversionchange: null as unknown,
    onclose: null as unknown,
    transaction: () => {
      const tx: Record<string, unknown> & { error: unknown } = { error: null };
      let aborted = false;
      let pendingPut: { value: unknown } | null = null;
      tx.abort = () => {
        if (aborted) return;
        aborted = true;
        queueMicrotask(() => (tx.onabort as () => void)?.());
      };
      tx.objectStore = () => ({
        get: () => {
          const request: Record<string, unknown> = {};
          void state.hold.then(() => {
            request.result = state.value === undefined ? undefined : structuredClone(state.value);
            (request.onsuccess as () => void)?.();
            queueMicrotask(() => {
              if (aborted) return;
              if (pendingPut) { state.value = structuredClone(pendingPut.value); state.puts += 1; }
              (tx.oncomplete as () => void)?.();
            });
          });
          return request;
        },
        put: (value: unknown) => { pendingPut = { value }; return {}; }
      });
      return tx;
    }
  };
  const factory = {
    open: () => {
      const request: Record<string, unknown> = { result: db };
      queueMicrotask(() => { (request.onupgradeneeded as ((e: { oldVersion: number }) => void) | undefined)?.({ oldVersion: 0 }); (request.onsuccess as () => void)(); });
      return request;
    }
  } as unknown as IDBFactory;
  return { state, factory };
}

const candidate = { ref: '/catalog-en/g-aaaaaa.db', job: 'aaaaaa', version: 'v1', sha256: 'a'.repeat(64), bytes: 10, createdAt: '2026-10-31T00:00:00.000Z' };

describe('role store: execution-time fence (S8-01)', () => {
  it('a transition queued behind other IndexedDB work that executes after the fence rose aborts BEFORE the put and reports RETIRED, nothing written', async () => {
    const idb = fakeIndexedDb();
    let fenced = false;
    const store = createRoleStoreFromCell(createIdbStateCell('t', { factory: idb.factory, isFenced: () => fenced }));
    let release!: () => void;
    idb.state.hold = new Promise<void>((resolve) => { release = resolve; });
    const pending = store.addCandidate('en', candidate).then(() => 'committed', (e: unknown) => (isRetiredError(e) ? 'RETIRED' : String(e)));
    await new Promise((r) => setTimeout(r, 20));
    fenced = true; // retired while the transition was still waiting its turn (call-time check had passed)
    release();
    expect(await pending).toBe('RETIRED');
    expect(idb.state.puts).toBe(0);
    expect(idb.state.value).toBeUndefined();
  });

  it('a transition that already executed before the fence reports committed (never "rejected after commit")', async () => {
    const idb = fakeIndexedDb();
    let fenced = false;
    const store = createRoleStoreFromCell(createIdbStateCell('t', { factory: idb.factory, isFenced: () => fenced }));
    const done = store.addCandidate('en', candidate);
    await done; // executed (and committed) while the fence was still down
    fenced = true;
    expect(idb.state.puts).toBe(1);
    expect((await store.language('en')).candidates).toHaveLength(1); // reads are never fenced
    await expect(store.addCandidate('en', { ...candidate, ref: '/catalog-en/g-bbbbbb.db', job: 'bbbbbb' })).rejects.toMatchObject({ code: 'RETIRED' });
    expect(idb.state.puts).toBe(1);
  });
});
