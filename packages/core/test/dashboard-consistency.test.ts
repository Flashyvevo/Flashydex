import { afterEach, describe, expect, it } from 'vitest';
import { copyOf, harness, installStandardCatalog, ownedCount, type Harness } from './helpers';

/** E04 (Sol review 3): the dashboard's totals and its recent rows come from one personal snapshot, or it retries then STALE_READ. */
const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

async function setup() {
  const h = await harness();
  open.push(h);
  await installStandardCatalog(h);
  const first = await h.collection.add(copyOf('tset-001'));
  const user = h.t.databases.user;
  const original = user.read.bind(user);
  let reads = 0;
  let busy = false;
  const state: { after: number | 'always'; action: (() => Promise<unknown>) | null; fired: number } = { after: 2, action: null, fired: 0 };
  user.read = (async (fn: Parameters<typeof original>[0]) => {
    const out = await original(fn);
    reads += 1;
    if (!busy && state.action && (state.after === 'always' || reads === state.after)) {
      busy = true;
      try { state.fired += 1; await state.action(); } finally { busy = false; }
    }
    return out;
  }) as typeof user.read;
  const reset = () => { reads = 0; };
  return { h, first, state, reset };
}

describe('E04 dashboard consistent personal read', () => {
  it("Sol's interleaving: sole copy deleted after the aggregate read, before recent hydration -> dashboard shows ONE snapshot (0 copies, 0 recent)", async () => {
    const s = await setup();
    s.state.action = () => s.h.collection.remove({ id: s.first.id });
    const dash = await s.h.portfolio.dashboard({});
    expect(s.state.fired).toBe(1);
    expect(await ownedCount(s.h)).toBe(0);
    expect(dash.totalCopies).toBe(0);
    expect(dash.recent).toHaveLength(0);
    expect(dash.currencies.every((c) => c.totalCopies === 0)).toBe(true);
  });

  it('a copy ADDED between aggregates and hydration -> totals and recent agree (2 copies, newest in recent)', async () => {
    const s = await setup();
    s.state.action = () => s.h.collection.add(copyOf('tset-002'));
    const dash = await s.h.portfolio.dashboard({});
    expect(s.state.fired).toBe(1);
    expect(dash.totalCopies).toBe(2);
    expect(dash.recent.length).toBe(2);
  });

  it('a copy UPDATED between aggregates and hydration -> the returned row reflects the update and totals are recomputed', async () => {
    const s = await setup();
    s.state.action = () => s.h.collection.update({ id: s.first.id, patch: { condition: 'LP' } });
    const dash = await s.h.portfolio.dashboard({});
    expect(s.state.fired).toBe(1);
    expect(dash.totalCopies).toBe(1);
    expect(dash.recent[0]).toMatchObject({ id: s.first.id, condition: 'LP' });
  });

  it('a write on EVERY attempt never produces a mixed answer: typed STALE_READ', async () => {
    const s = await setup();
    s.state.after = 'always';
    s.state.action = () => s.h.collection.add(copyOf('tset-002'));
    await expect(s.h.portfolio.dashboard({})).rejects.toMatchObject({ code: 'STALE_READ' });
  });

  it('without interleaving the dashboard is unchanged (1 copy, 1 recent)', async () => {
    const s = await setup();
    const dash = await s.h.portfolio.dashboard({});
    expect(dash.totalCopies).toBe(1);
    expect(dash.recent).toHaveLength(1);
  });
});
