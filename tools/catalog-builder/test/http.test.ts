import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Fetcher, HttpError, pool } from '../src/http';

const dir = mkdtempSync(join(tmpdir(), 'fdx-http-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), { status: 200, ...init });
}

describe('Fetcher', () => {
  it('retries 5xx with 1/2/4 s backoff plus jitter, then succeeds', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetcher = new Fetcher({
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0.5,
      fetchImpl: (async () => (++calls < 4 ? new Response('x', { status: 503 }) : json({ ok: true }))) as typeof fetch
    });
    await expect(fetcher.getJson('https://x/a')).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([1125, 2125, 4125]);
    expect(fetcher.stats.retries).toBe(3);
  });

  it('gives up after the retry budget and reports the status', async () => {
    const fetcher = new Fetcher({ sleep: async () => undefined, fetchImpl: (async () => new Response('x', { status: 500 })) as typeof fetch });
    await expect(fetcher.getJson('https://x/b')).rejects.toMatchObject({ status: 500 });
  });

  it('does not retry a 404', async () => {
    let calls = 0;
    const fetcher = new Fetcher({ sleep: async () => undefined, fetchImpl: (async () => { calls += 1; return new Response('', { status: 404 }); }) as typeof fetch });
    await expect(fetcher.getJson('https://x/c')).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
    expect(fetcher.stats.http404).toBe(1);
  });

  it('halves concurrency on 429 and honours Retry-After capped at 60 s', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetcher = new Fetcher({
      concurrency: 8, random: () => 0, sleep: async (ms) => { sleeps.push(ms); },
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '3' } })
          : calls === 2 ? new Response('', { status: 429, headers: { 'retry-after': '999' } })
            : json({ ok: 1 });
      }) as typeof fetch
    });
    await fetcher.getJson('https://x/d');
    expect(sleeps).toEqual([3000, 60_000]);
    expect(fetcher.currentConcurrency).toBe(2); // 8 -> 4 -> 2
    expect(fetcher.stats.http429).toBe(2);
  });

  it('never runs more requests than the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const fetcher = new Fetcher({
      concurrency: 3,
      fetchImpl: (async () => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active -= 1; return json(1); }) as typeof fetch
    });
    await Promise.all(Array.from({ length: 20 }, (_, i) => fetcher.getJson(`https://x/${i}`)));
    expect(peak).toBe(3);
  });

  it('reuses the on-disk cache and refetches when it is stale', async () => {
    let now = 1_000_000;
    let calls = 0;
    const fetcher = new Fetcher({ now: () => now, maxCacheAgeMs: 1000, fetchImpl: (async () => json({ n: ++calls })) as typeof fetch });
    const file = join(dir, 'cards', 'x.json');
    expect(await fetcher.getJson('https://x/e', file)).toEqual({ n: 1 });
    expect(await fetcher.getJson('https://x/e', file)).toEqual({ n: 1 });
    expect(fetcher.stats.cacheHits).toBe(1);
    now += 5000;
    expect(await fetcher.getJson('https://x/e', file)).toEqual({ n: 2 });
    const resumed = new Fetcher({ now: () => now + 1e9, maxCacheAgeMs: Number.POSITIVE_INFINITY, fetchImpl: (async () => { throw new Error('network must not be used'); }) as typeof fetch });
    expect(await resumed.getJson('https://x/e', file)).toEqual({ n: 2 });
  });
});

describe('pool', () => {
  it('limits parallelism and keeps result order', async () => {
    let active = 0;
    let peak = 0;
    const out = await pool([1, 2, 3, 4, 5, 6], 2, async (n) => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 3)); active -= 1; return n * 2; });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
});
