import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '../src/errors';
import { CatalogInstallService } from '../src/services/catalog-install';
import { FakeDiskPort } from '../src/testing/fake-install-port';
import { copyOf, harness, type Harness } from './helpers';

/**
 * Stage E / E2 + N07: a catalog reader that already holds a handle must survive an activation that retires it
 * (pause after the first statement / before the first statement, activate, continue). Result: a correct answer from ONE consistent
 * catalog, or a typed STALE_READ / MAINTENANCE. Never a raw driver error ("The database connection is not open").
 */
const V1 = '2026.10.31.001';
const V2 = '2026.11.01.001';
const V3 = '2026.12.01.001';
const noop = () => undefined;
const sig = () => new AbortController().signal;
const CFG = { trustedOrigins: ['https://example.test'] };

const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

async function setup() {
  const h = await harness();
  open.push(h);
  const port = new FakeDiskPort(h.t.dir, h.t.env);
  const svc = new CatalogInstallService(h.ctx, port, CFG);
  port.manifestJson = FakeDiskPort.manifest(['en'], V1, 'a'.repeat(64));
  await svc.install('en', noop, sig());
  await h.collection.add(copyOf('tset-001'));
  await h.collection.add(copyOf('tset-002'));
  let nextVersion = V2;
  const replace = async () => {
    port.manifestJson = FakeDiskPort.manifest(['en'], nextVersion, (nextVersion === V2 ? 'b' : 'c').repeat(64));
    nextVersion = V3;
    await svc.install('en', noop, sig());
  };
  /** Wrap the CURRENT cached read-only handle so a full catalog activation runs `times` times around its statements. */
  const arm = async (when: 'before' | 'after', times = 1) => {
    const db = (await h.t.databases.catalog('en'))!;
    let fired = 0;
    for (const m of ['scalar', 'select', 'rows'] as const) {
      const original = (db[m] as (...a: unknown[]) => Promise<unknown>).bind(db);
      (db as unknown as Record<string, unknown>)[m] = async (...a: unknown[]) => {
        if (when === 'before' && fired < times) { fired += 1; await replace(); }
        const result = await original(...a);
        if (when === 'after' && fired < times) { fired += 1; await replace(); }
        return result;
      };
    }
    return () => fired;
  };
  return { h, port, svc, arm };
}

const outcome = async <T,>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string | null; message: string }> => {
  try { return { ok: true, value: await p }; } catch (e) { return { ok: false, code: e instanceof DomainError ? e.code : null, message: (e as Error).message }; }
};
const consistent = (r: { ok: true; value: unknown } | { ok: false; code: string | null; message: string }) => {
  if (r.ok) return true;
  return r.code === 'STALE_READ' || r.code === 'MAINTENANCE';
};

describe('N07 existing readers survive an activation (pause -> activate -> continue)', () => {
  it("search: Sol's probe (paused after COUNT, activation completes, SELECT continues) -> correct result from the NEW catalog, no raw driver error", async () => {
    const t = await setup();
    const fired = await t.arm('after');
    const r = await outcome(t.h.catalog.searchCards({ q: 'Alpha', language: 'en', match: 'contains' }));
    expect(fired()).toBe(1);
    expect(r.ok ? 'ok' : `${r.code}:${r.message}`).toBe('ok');
    if (r.ok) {
      expect(r.value.page.total).toBe(2);
      expect(r.value.data.every((c) => c.name.startsWith(V2))).toBe(true); // one consistent catalog (the new one)
    }
  });

  it('search: activation completes BEFORE the first statement on an already-obtained handle', async () => {
    const t = await setup();
    await t.arm('before');
    const r = await outcome(t.h.catalog.searchCards({ q: 'Beta', language: 'en', match: 'contains' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.data.map((c) => c.name)).toEqual([`${V2} Beta Mon`]);
  });

  it('card detail (catalog row + hydrated copies + quotes)', async () => {
    const t = await setup();
    await t.arm('after');
    const r = await outcome(t.h.catalog.getCard({ language: 'en', cardId: 'tset-001' }));
    expect(r.ok ? 'ok' : `${r.code}:${r.message}`).toBe('ok');
    if (r.ok) {
      expect(r.value.name.startsWith(V2)).toBe(true);
      expect(r.value.ownedCopies.data).toHaveLength(1);
    }
  });

  it('set cards (manifest lookup, then card rows)', async () => {
    const t = await setup();
    await t.arm('after');
    const r = await outcome(t.h.catalog.listSetCards({ language: 'en', setId: 'tset', ownership: 'all' }));
    expect(r.ok ? 'ok' : `${r.code}:${r.message}`).toBe('ok');
    if (r.ok) expect(r.value.data.every((c) => c.name.startsWith(V2))).toBe(true);
  });

  it('set list + set detail (multiple catalog() lookups per call: never a mix of two catalogs)', async () => {
    const t = await setup();
    await t.arm('after');
    const list = await outcome(t.h.catalog.listSets({ language: 'en' } as never));
    expect(list.ok ? 'ok' : `${list.code}:${list.message}`).toBe('ok');
    const t2 = await setup();
    await t2.arm('after');
    const detail = await outcome(t2.h.catalog.getSet({ language: 'en', setId: 'tset' }));
    expect(detail.ok ? 'ok' : `${detail.code}:${detail.message}`).toBe('ok');
  });

  it('dashboard (valuation quotes read the catalog)', async () => {
    const t = await setup();
    await t.arm('before');
    const r = await outcome(t.h.portfolio.dashboard({}));
    expect(r.ok ? 'ok' : `${r.code}:${r.message}`).toBe('ok');
    if (r.ok) expect(r.value.totalCopies).toBe(2);
  });

  it('copy hydration (getCopy) and the collection list', async () => {
    const t = await setup();
    const copy = (await t.h.collection.list({ groupBy: 'copy' })).data[0] as { id: string };
    await t.arm('before');
    const one = await outcome(t.h.collection.getCopy({ id: copy.id }));
    expect(one.ok ? 'ok' : `${one.code}:${one.message}`).toBe('ok');
    const t2 = await setup();
    await t2.arm('before');
    const list = await outcome(t2.h.collection.list({ groupBy: 'copy' }));
    expect(list.ok ? 'ok' : `${list.code}:${list.message}`).toBe('ok');
  });

  it('two activations during one read: the second is a typed STALE_READ (never a raw driver error)', async () => {
    const t = await setup();
    const fired = await t.arm('after', 1);
    // re-arm the replacement handle too, so the retry is also overtaken
    const original = t.h.t.databases.catalog.bind(t.h.t.databases);
    let handed = 0;
    t.h.t.databases.catalog = async (language) => {
      const db = await original(language);
      if (db && handed++ === 1) {
        for (const m of ['scalar', 'select', 'rows'] as const) {
          const orig = (db[m] as (...a: unknown[]) => Promise<unknown>).bind(db);
          let once = false;
          (db as unknown as Record<string, unknown>)[m] = async (...a: unknown[]) => { const r = await orig(...a); if (!once) { once = true; await t.svc.install('en', noop, sig()).catch(noop); t.port.manifestJson = FakeDiskPort.manifest(['en'], '2027.01.01.001', 'd'.repeat(64)); await t.svc.install('en', noop, sig()); } return r; };
        }
      }
      return db;
    };
    const r = await outcome(t.h.catalog.searchCards({ q: 'Alpha', language: 'en', match: 'contains' }));
    expect(fired()).toBe(1);
    expect(consistent(r)).toBe(true);
    if (!r.ok) expect(r.code).toBe('STALE_READ');
  });
});
