import { describe, expect, it } from 'vitest';
import { IMAGE_ALLOWED_ORIGIN } from '../../web-storage/contract';
import { createImageHandler } from './handler';
import type { ImageEngine } from './engine';

/**
 * S5-07: clones are admitted through a bounded slot taken BEFORE response.clone(). N concurrent image responses must never hold more than
 * K unread clone bodies, and the ones that found no slot are served network-only (no clone, no cache write).
 */
describe('image handler clone admission', () => {
  function setup(slots: number, count: number) {
    let clones = 0;
    let admitted = 0;
    let live = 0; // clones created and not yet fully admitted
    let maxLive = 0;
    const gates: Array<() => void> = [];
    const engine = {
      lookup: async () => null,
      touch: async () => undefined,
      markFresh: async () => undefined,
      admit: () => new Promise((resolve) => { gates.push(() => { admitted++; live--; resolve({ ok: true }); }); }) // a deliberately slow cache writer
    } as unknown as ImageEngine;
    const make = () => {
      const response = new Response(new Uint8Array(64), { status: 200, headers: { 'content-type': 'image/webp' } }); // no Content-Length
      const realClone = response.clone.bind(response);
      response.clone = () => { clones++; live++; maxLive = Math.max(maxLive, live); return realClone(); };
      return response;
    };
    const waits: Promise<unknown>[] = [];
    const handler = createImageHandler({ engine, maxAdmissions: slots, fetchFn: async () => make() });
    const run = () => Promise.all(Array.from({ length: count }, (_, i) => handler.handle(new Request(`${IMAGE_ALLOWED_ORIGIN}/en/base/base1/${i}/low.webp`), (p) => { waits.push(p); })));
    return { run, waits, gates, stats: () => ({ clones, admitted, maxLive }) };
  }

  it('20 concurrent images, K=2: never more than 2 clones alive, the rest served network-only', async () => {
    const t = setup(2, 20);
    const responses = await t.run();
    expect(responses).toHaveLength(20);
    expect(t.stats().clones).toBe(2);
    expect(t.stats().maxLive).toBeLessThanOrEqual(2);
    expect(t.waits).toHaveLength(2); // only admitted ones hold the worker alive
    // every page branch is still fully readable (network-only responses are not consumed or cancelled)
    for (const r of responses) expect((await r.arrayBuffer()).byteLength).toBe(64);
    // drain the slow writer: a slot frees up and the next image gets cached again
    for (let i = 0; i < 50 && t.gates.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    t.gates.shift()!();
    for (let i = 0; i < 50 && t.gates.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    t.gates.shift()!();
    await Promise.all(t.waits);
    expect(t.stats().admitted).toBe(2);
    const again = await t.run();
    expect(again).toHaveLength(20);
    expect(t.stats().maxLive).toBeLessThanOrEqual(2);
    expect(t.stats().clones).toBe(4);
  });

  it('K=1 serves sequential images through the slot one after another', async () => {
    const t = setup(1, 3);
    await t.run();
    expect(t.stats().clones).toBe(1);
    for (let i = 0; i < 50 && t.gates.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    t.gates.shift()!();
    await Promise.all(t.waits);
    expect(t.stats().maxLive).toBe(1);
  });
});
