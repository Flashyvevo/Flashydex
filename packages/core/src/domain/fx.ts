/**
 * Derived FX layer (pricing v2 Phase A). Pure and deterministic: no I/O, no clock, no default rate.
 * A converted amount is a DISPLAY derivation; it is never stored as a quote/observation.
 */

export type FxRecord = {
  base: 'EUR';
  quote: 'USD';
  /** Decimal string, e.g. "1.1165". */
  rate: string;
  /** ECB reference date, YYYY-MM-DD. */
  rateDate: string;
  provider: 'frankfurter';
  /** Instant the record was fetched. */
  fetchedAt: string;
};

/** Already-loaded snapshot supplied by the app; core never fetches. */
export interface FxProvider {
  get(base: 'EUR', quote: 'USD'): FxRecord | null;
}

/** What valuation math receives: the record plus its staleness (computed once from the context clock). */
export type FxContext = { record: FxRecord; stale: boolean };

export const FX_STALE_DAYS = 7;
export const FX_MAX_FRACTION_DIGITS = 12;
/** First ECB euro reference rate date. */
export const FX_EARLIEST_RATE_DATE = '1999-01-04';
const MAX_CENTS_BIG = 2147483647n;
const DAY_MS = 86_400_000;
/** Clock-skew tolerance for `fetchedAt` against the supplied "now". */
const FETCHED_SKEW_MS = 5 * 60_000;

const DECIMAL = /^(\d+)(?:\.(\d{1,12}))?$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

/** An exact decimal: value = unscaled / 10^scale. */
export type ExactRate = { unscaled: bigint; scale: number };

/** Parse a positive decimal string (<= 12 fractional digits, 0 < rate < 1000) with FULL precision. Null when malformed or implausible. */
export function parseRateExact(rate: unknown): ExactRate | null {
  if (typeof rate !== 'string') return null;
  const m = DECIMAL.exec(rate);
  if (!m) return null;
  const frac = m[2] ?? '';
  const scale = frac.length;
  const unscaled = BigInt((m[1] as string) + frac);
  if (unscaled <= 0n || unscaled >= 1000n * 10n ** BigInt(scale)) return null;
  return { unscaled, scale };
}

/** True for a real calendar date YYYY-MM-DD (month/day validated by round-trip). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_ONLY.exec(value);
  if (!m) return false;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/**
 * Convert integer cents by a decimal-string rate with EXACT decimal arithmetic: cents x unscaled / 10^scale, rounded half-up once on
 * the exact remainder, BigInt throughout (no float). Throws RangeError for a negative/unsafe input, a malformed rate, or a result
 * above MAX_CENTS (2^31-1).
 */
export function convertCents(cents: number, rate: string): number {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('Cents must be a non-negative safe integer');
  const exact = parseRateExact(rate);
  if (exact === null) throw new RangeError('Invalid FX rate');
  const denom = 10n ** BigInt(exact.scale);
  const product = BigInt(cents) * exact.unscaled;
  let out = product / denom;
  if ((product % denom) * 2n >= denom) out += 1n; // half-up on the exact remainder
  if (out > MAX_CENTS_BIG) throw new RangeError('Converted amount exceeds the supported range');
  return Number(out);
}

/** Like convertCents but null instead of throwing. */
export function tryConvertCents(cents: number, rate: string): number | null {
  try {
    return convertCents(cents, rate);
  } catch {
    return null;
  }
}

/** True when the record's rate date is more than 7 whole days before `now` (an Instant). Malformed dates count as stale. */
export function isFxStale(record: Pick<FxRecord, 'rateDate'>, now: string): boolean {
  const rate = Date.parse(`${record.rateDate}T00:00:00.000Z`);
  const current = Date.parse(now);
  if (!Number.isFinite(rate) || !Number.isFinite(current)) return true;
  return current - rate > FX_STALE_DAYS * DAY_MS;
}

/**
 * Strict validation of an UNKNOWN value (fetched, or read back from storage) against the clock `now` (an Instant).
 * rate: decimal string in (0,1000), <= 12 fractional digits; rateDate: real calendar date, 1999-01-04 <= date <= now + 1 day;
 * fetchedAt: ISO instant not in the future (5 min skew); provider literal. Returns a clean record or null.
 */
export function validateFxRecord(input: unknown, now: string): FxRecord | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  if (r.base !== 'EUR' || r.quote !== 'USD' || r.provider !== 'frankfurter') return null;
  if (parseRateExact(r.rate) === null) return null;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return null;
  if (!isCalendarDate(r.rateDate) || r.rateDate < FX_EARLIEST_RATE_DATE) return null;
  if (Date.parse(`${r.rateDate}T00:00:00.000Z`) > nowMs + DAY_MS) return null;
  if (typeof r.fetchedAt !== 'string') return null;
  const t = INSTANT.exec(r.fetchedAt);
  if (!t || !isCalendarDate(t[1]) || Number(t[2]) > 23 || Number(t[3]) > 59 || Number(t[4]) > 59) return null;
  const fetchedMs = Date.parse(r.fetchedAt);
  if (!Number.isFinite(fetchedMs) || fetchedMs > nowMs + FETCHED_SKEW_MS) return null;
  return { base: 'EUR', quote: 'USD', rate: r.rate as string, rateDate: r.rateDate, provider: 'frankfurter', fetchedAt: r.fetchedAt };
}

export function isValidFxRecord(record: unknown, now: string): record is FxRecord {
  return validateFxRecord(record, now) !== null;
}

/** Snapshot the provider once for a computation; null = FX unavailable. */
export function resolveFx(provider: FxProvider | undefined, now: string): FxContext | null {
  const record = provider?.get('EUR', 'USD') ?? null;
  if (!isValidFxRecord(record, now)) return null;
  return { record, stale: isFxStale(record, now) };
}
