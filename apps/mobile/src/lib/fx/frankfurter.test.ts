import { describe, expect, it, vi } from 'vitest';
import { FRANKFURTER_URL, fetchFrankfurter, parseFrankfurter } from './frankfurter';

// Verbatim from `curl "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD"` on 2026-11-08.
const REAL = '{"amount":1.0,"base":"EUR","date":"2026-11-06","rates":{"USD":1.1165}}';
const NOW = '2026-11-08T10:00:00.000Z';

describe('parseFrankfurter', () => {
  it('parses the real response', () => {
    expect(parseFrankfurter(JSON.parse(REAL), NOW)).toEqual({ base: 'EUR', quote: 'USD', rate: '1.1165', rateDate: '2026-11-06', provider: 'frankfurter', fetchedAt: NOW });
  });
  it('rejects malformed bodies without inventing anything', () => {
    const bad: unknown[] = [
      null, 'x', 42, [], {}, { base: 'EUR' }, { base: 'USD', date: '2026-11-06', rates: { USD: 1.1 } }, { base: 'EUR', date: '06-11-2026', rates: { USD: 1.1 } },
      { base: 'EUR', date: '2026-11-06', rates: {} }, { base: 'EUR', date: '2026-11-06', rates: { USD: '1.1' } }, { base: 'EUR', date: '2026-11-06', rates: { USD: 0 } },
      { base: 'EUR', date: '2026-11-06', rates: { USD: -1 } }, { base: 'EUR', date: '2026-11-06', rates: { USD: null } }, { base: 'EUR', date: '2026-11-06', rates: { USD: 1e-7 } },
      { base: 'EUR', date: '2026-11-06', rates: { USD: 5000 } }, { base: 'EUR', date: '2026-11-06' }
    ];
    for (const body of bad) expect(parseFrankfurter(body, NOW), JSON.stringify(body)).toBeNull();
  });
  it('rejects impossible calendar dates, pre-euro dates and over-long rates', () => {
    expect(parseFrankfurter({ base: 'EUR', date: '2026-02-31', rates: { USD: 1.1 } }, NOW)).toBeNull();
    expect(parseFrankfurter({ base: 'EUR', date: '2026-13-01', rates: { USD: 1.1 } }, NOW)).toBeNull();
    expect(parseFrankfurter({ base: 'EUR', date: '1998-12-31', rates: { USD: 1.1 } }, NOW)).toBeNull();
    expect(parseFrankfurter({ base: 'EUR', date: '2026-11-06', rates: { USD: 1.1234567890123 } }, NOW)).toBeNull();
    expect(parseFrankfurter({ base: 'EUR', date: '2026-11-06', rates: { USD: 1.1234567 } }, NOW)?.rate).toBe('1.1234567');
    expect(parseFrankfurter({ base: 'EUR', date: '2026-11-06', rates: { USD: 1.1 } }, 'not-a-clock')).toBeNull();
  });
  it('rejects a rate dated more than a day in the future', () => {
    expect(parseFrankfurter({ base: 'EUR', date: '2026-11-20', rates: { USD: 1.1 } }, NOW)).toBeNull();
    expect(parseFrankfurter({ base: 'EUR', date: '2026-11-09', rates: { USD: 1.1 } }, NOW)).not.toBeNull();
  });
});

describe('fetchFrankfurter', () => {
  it('returns a record on success and calls the documented URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(REAL, { status: 200 })) as unknown as typeof fetch;
    const record = await fetchFrankfurter(fetchImpl, () => NOW);
    expect(record?.rate).toBe('1.1165');
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(FRANKFURTER_URL);
  });
  it('offline (fetch throws), HTTP error and garbage JSON all resolve null', async () => {
    expect(await fetchFrankfurter((async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch, () => NOW)).toBeNull();
    expect(await fetchFrankfurter((async () => new Response('nope', { status: 503 })) as unknown as typeof fetch, () => NOW)).toBeNull();
    expect(await fetchFrankfurter((async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch, () => NOW)).toBeNull();
    expect(await fetchFrankfurter((async () => new Response('{"base":"EUR"}', { status: 200 })) as unknown as typeof fetch, () => NOW)).toBeNull();
  });
});
