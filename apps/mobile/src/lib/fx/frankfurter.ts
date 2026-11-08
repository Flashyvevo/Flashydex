import { validateFxRecord, type FxRecord } from '@flashydex/core';

/** Frankfurter (ECB reference rates, published on weekdays). Real response shape, verified with curl:
 *  {"amount":1.0,"base":"EUR","date":"2026-11-06","rates":{"USD":1.1165}} */
export const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a Frankfurter body into an FxRecord, or null when anything about it is off. Never invents a field. */
export function parseFrankfurter(body: unknown, fetchedAt: string): FxRecord | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as { base?: unknown; date?: unknown; rates?: unknown };
  if (b.base !== 'EUR' || typeof b.date !== 'string' || !DATE.test(b.date)) return null;
  if (b.rates === null || typeof b.rates !== 'object') return null;
  const raw = (b.rates as { USD?: unknown }).USD;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  const rate = String(raw);
  if (!/^\d+(\.\d+)?$/.test(rate)) return null; // exponent forms etc.: refuse rather than guess
  // Same strict validation as the storage read path (real calendar date, <= 1 day ahead, >= 1999-01-04, rate <= 12 fractional digits).
  return validateFxRecord({ base: 'EUR', quote: 'USD', rate, rateDate: b.date, provider: 'frankfurter', fetchedAt }, fetchedAt);
}

/** One network fetch. Resolves null on offline/HTTP/parse failure (callers keep the last verified record). */
export async function fetchFrankfurter(fetchImpl: typeof fetch, now: () => string, signal?: AbortSignal): Promise<FxRecord | null> {
  try {
    const response = await fetchImpl(FRANKFURTER_URL, { signal, headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    return parseFrankfurter(await response.json(), now());
  } catch {
    return null;
  }
}
