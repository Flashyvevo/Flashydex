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

/** S6-04: queued clones must not accumulate bytes; revalidation must not leave an unconsumed branch. */
describe('image handler tee bytes (S6-04)', () => {
  const CAP = 1024;
  const CHUNK = 512;

  function streaming(totalBytes: number, produced: { n: number }): Response {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) return controller.close();
        sent += CHUNK;
        produced.n += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK));
      }
    }, { highWaterMark: 0 });
    return new Response(stream, { status: 200, headers: { 'content-type': 'image/webp' } }); // unknown length: no Content-Length
  }

  /** Counts the bytes the handler reads from the clone and whether it started reading at all. */
  function spyClone(response: Response, spy: { started: boolean; bytes: number }): void {
    const realClone = response.clone.bind(response);
    response.clone = () => {
      const clone = realClone();
      const body = clone.body!;
      const getReader = body.getReader.bind(body) as () => ReadableStreamDefaultReader<Uint8Array>;
      (body as unknown as { getReader: () => ReadableStreamDefaultReader<Uint8Array> }).getReader = () => {
        spy.started = true;
        const reader = getReader();
        const read = reader.read.bind(reader);
        reader.read = async () => { const r = await read(); if (r.value) spy.bytes += r.value.byteLength; return r; };
        return reader;
      };
      return clone;
    };
  }

  it('a clone queued behind a slow writer starts its capped read at once and never reads past the cap', async () => {
    const gates: Array<() => void> = [];
    const engine = {
      lookup: async () => null, touch: async () => undefined, markFresh: async () => undefined,
      admit: () => new Promise((resolve) => { gates.push(() => resolve({ ok: true })); }) // slow writer: blocks until released
    } as unknown as ImageEngine;
    const small = new Response(new Uint8Array(64), { status: 200, headers: { 'content-type': 'image/webp' } });
    const bigProduced = { n: 0 };
    const big = streaming(2 * 1024 * 1024, bigProduced);
    const spy = { started: false, bytes: 0 };
    spyClone(big, spy);
    const responses = [small, big];
    const waits: Promise<unknown>[] = [];
    const handler = createImageHandler({ engine, maxAdmissions: 2, perEntryMax: CAP, fetchFn: async () => responses.shift()! });
    const first = await handler.handle(new Request(`${IMAGE_ALLOWED_ORIGIN}/en/base/base1/1/low.webp`), (p) => { waits.push(p); });
    const second = await handler.handle(new Request(`${IMAGE_ALLOWED_ORIGIN}/en/base/base1/2/low.webp`), (p) => { waits.push(p); });
    expect(waits).toHaveLength(2);
    // the page drains the whole 2 MiB while the first entry is still stuck in the slow writer
    expect((await second.arrayBuffer()).byteLength).toBe(2 * 1024 * 1024);
    await first.arrayBuffer();
    for (let i = 0; i < 50 && gates.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(gates).toHaveLength(1); // the writer is still blocked on entry 1
    expect(spy.started).toBe(true); // the waiting clone was read immediately ...
    expect(spy.bytes).toBeLessThanOrEqual(CAP + CHUNK); // ... and never past the cap (+ one chunk), even though the page read all 2 MiB
    gates.shift()!();
    await Promise.all(waits);
    expect(gates).toHaveLength(0); // the oversized entry was dropped, never written
  });

  it('background revalidation consumes the network response directly: no clone, no unconsumed branch', async () => {
    let admitted = 0;
    const engine = {
      lookup: async () => ({ response: new Response('cached'), stale: true, etag: 'e1' }),
      touch: async () => undefined, markFresh: async () => undefined,
      admit: async () => { admitted++; return { ok: true }; }
    } as unknown as ImageEngine;
    const net = new Response(new Uint8Array(64), { status: 200, headers: { 'content-type': 'image/webp' } });
    let clones = 0;
    const realClone = net.clone.bind(net);
    net.clone = () => { clones++; return realClone(); };
    const waits: Promise<unknown>[] = [];
    const handler = createImageHandler({ engine, perEntryMax: CAP, fetchFn: async () => net });
    await handler.handle(new Request(`${IMAGE_ALLOWED_ORIGIN}/en/base/base1/1/low.webp`), (p) => { waits.push(p); });
    await Promise.all(waits);
    expect(clones).toBe(0);
    expect(net.bodyUsed).toBe(true); // fully consumed by the single capped read
    expect(admitted).toBe(1);
  });
});
