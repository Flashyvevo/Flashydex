const MAX_CENTS = 2_147_483_647;

/** Expand a JS number's shortest decimal representation (possibly exponent form) into plain digits. */
function toPlainDecimal(text: string): string | null {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!match) return null;
  const [, sign = '', intPart = '', fracPart = '', exp = '0'] = match;
  if (intPart === '' && fracPart === '') return null;
  let digits = intPart + fracPart;
  let pointIndex = intPart.length + Number(exp);
  if (pointIndex <= 0) {
    digits = '0'.repeat(1 - pointIndex) + digits;
    pointIndex = 1;
  } else if (pointIndex > digits.length) {
    digits += '0'.repeat(pointIndex - digits.length);
  }
  return `${sign}${digits.slice(0, pointIndex)}.${digits.slice(pointIndex) || '0'}`;
}

export type CentsResult = { cents: number | null; warning: 'negative' | 'invalid' | 'overflow' | null };

/**
 * Decimal half-up conversion to integer cents without binary floating point multiplication.
 * `0.27 -> 27`, `458.1 -> 45810`, `1.005 -> 101`, `0 -> 0` (a genuine zero stays zero).
 * Absent (`null`/`undefined`) is `{cents: null, warning: null}`; invalid/negative/overflow are null plus a warning.
 */
export function parseCents(value: unknown): CentsResult {
  if (value === null || value === undefined) return { cents: null, warning: null };
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { cents: null, warning: 'invalid' };
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    return { cents: null, warning: 'invalid' };
  }
  const plain = toPlainDecimal(text);
  if (plain === null) return { cents: null, warning: 'invalid' };
  const negative = plain.startsWith('-');
  const [whole = '0', frac = ''] = plain.replace(/^[+-]/, '').split('.');
  const padded = `${frac}00`;
  let cents = BigInt(whole || '0') * 100n + BigInt(padded.slice(0, 2));
  if (padded.charCodeAt(2) >= 53 /* '5' */) cents += 1n; // half-up on the third decimal digit
  if (negative) return cents === 0n ? { cents: 0, warning: null } : { cents: null, warning: 'negative' };
  if (cents > BigInt(MAX_CENTS)) return { cents: null, warning: 'overflow' };
  return { cents: Number(cents), warning: null };
}
