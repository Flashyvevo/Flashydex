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

export const FX_SCALE_DIGITS = 6;
const SCALE = 10n ** BigInt(FX_SCALE_DIGITS);
const MAX_RATE_SCALED = 1000n * SCALE; // sanity bound: EUR→USD is never anywhere near 1000
export const FX_STALE_DAYS = 7;
const MAX_CENTS_BIG = 2147483647n;
const DAY_MS = 86_400_000;

const DECIMAL = /^(\d{1,4})(?:\.(\d{1,12}))?$/;

/** Parse a positive decimal string to a BigInt scaled by 10^6, rounding half-up beyond 6 digits. Null when malformed, zero or implausible. */
export function parseRateScaled(rate: string): bigint | null {
  const m = DECIMAL.exec(rate);
  if (!m) return null;
  const whole = BigInt(m[1] as string);
  const frac = m[2] ?? '';
  const kept = (frac + '0'.repeat(FX_SCALE_DIGITS)).slice(0, FX_SCALE_DIGITS);
  let scaled = whole * SCALE + BigInt(kept);
  if (frac.length > FX_SCALE_DIGITS && (frac.charCodeAt(FX_SCALE_DIGITS) - 48) >= 5) scaled += 1n;
  if (scaled <= 0n || scaled > MAX_RATE_SCALED) return null;
  return scaled;
}

/**
 * Convert integer cents by a decimal-string rate: round half-up to the cent, BigInt throughout (no float).
 * Throws RangeError for a negative/unsafe input, a malformed rate, or a result above MAX_CENTS (2^31-1).
 */
export function convertCents(cents: number, rate: string): number {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('Cents must be a non-negative safe integer');
  const scaled = parseRateScaled(rate);
  if (scaled === null) throw new RangeError('Invalid FX rate');
  const out = (BigInt(cents) * scaled + SCALE / 2n) / SCALE; // floor((x + 0.5)) == round half-up for non-negatives
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

/** A usable record: parseable positive rate and a calendar date. Anything else is treated as "no record". */
export function isValidFxRecord(record: FxRecord | null | undefined): record is FxRecord {
  if (!record || record.base !== 'EUR' || record.quote !== 'USD') return false;
  if (parseRateScaled(record.rate) === null) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(record.rateDate) && Number.isFinite(Date.parse(`${record.rateDate}T00:00:00.000Z`));
}

/** Snapshot the provider once for a computation; null = FX unavailable. */
export function resolveFx(provider: FxProvider | undefined, now: string): FxContext | null {
  const record = provider?.get('EUR', 'USD') ?? null;
  if (!isValidFxRecord(record)) return null;
  return { record, stale: isFxStale(record, now) };
}
