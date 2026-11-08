import type { GradedInfo, OutlierRule, SoldRecord, SoldSummary, SoldSummaryBucket } from './types';

export interface SummariseOptions {
  windowDays: number;
  now: Date;
  outlier: OutlierRule;
}

const DAY_MS = 86_400_000;
/** Conventional 1.5 x IQR Tukey fence. */
const IQR_K = 1.5;
/** Modified z-score cut-off (Iglewicz & Hoaglin) and its MAD->sigma constant. */
const MAD_CUTOFF = 3.5;
const MAD_SCALE = 1.4826;

function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

function medianOf(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Returns the values to KEEP. Fewer than 4 points are never trimmed (too little data to call anything an outlier). */
function trimOutliers(sorted: readonly number[], rule: OutlierRule): number[] {
  if (sorted.length < 4) return [...sorted];
  if (rule === 'iqr') {
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    const lo = q1 - IQR_K * iqr;
    const hi = q3 + IQR_K * iqr;
    return sorted.filter((v) => v >= lo && v <= hi);
  }
  const med = medianOf(sorted) as number;
  const deviations = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = medianOf(deviations) as number;
  // MAD of 0 means more than half the sales are identical; a modified z-score is undefined, so keep everything.
  if (mad === 0) return [...sorted];
  return sorted.filter((v) => (Math.abs(v - med) / (MAD_SCALE * mad)) <= MAD_CUTOFF);
}

function bucketKey(graded: GradedInfo | null, currency: string): string {
  return graded ? `graded|${graded.company.trim().toUpperCase()}|${graded.grade.trim()}|${currency}` : `raw|${currency}`;
}

function assertVerifiedSale(record: unknown, index: number): asserts record is SoldRecord {
  const kind = (record as { kind?: unknown } | null)?.kind;
  if (kind !== 'verified-sale') {
    throw new TypeError(`summariseSold: record[${index}] is not a verified sale (kind=${String(kind)}); listings and estimates must never be summarised as sales`);
  }
}

/**
 * Pure sold-price summary. Records are bucketed by (graded company+grade | raw) x currency, so a PSA 10 never
 * mixes with a PSA 9 or a raw copy, and currencies never mix. Per bucket: out-of-window and bundle records are
 * excluded, then outliers (IQR or MAD) are trimmed, then mean/median are taken over what remains.
 *
 * Window: soldAt in (now - windowDays, now]. Unparseable or future timestamps count as out-of-window.
 * Runtime guard: any record whose `kind` is not 'verified-sale' throws (defence in depth behind the type).
 */
export function summariseSold(records: readonly SoldRecord[], options: SummariseOptions): SoldSummary[] {
  const { windowDays, now, outlier } = options;
  if (!(windowDays > 0) || !Number.isFinite(windowDays)) throw new RangeError('summariseSold: windowDays must be a positive number');
  const nowMs = now.getTime();
  const startMs = nowMs - windowDays * DAY_MS;

  const groups = new Map<string, { bucket: SoldSummaryBucket; kept: number[]; outOfWindow: number; bundle: number }>();
  records.forEach((record, index) => {
    assertVerifiedSale(record, index);
    const graded = record.graded ? { company: record.graded.company.trim().toUpperCase(), grade: record.graded.grade.trim() } : null;
    const key = bucketKey(graded, record.currency);
    let group = groups.get(key);
    if (!group) {
      group = { bucket: { graded, currency: record.currency }, kept: [], outOfWindow: 0, bundle: 0 };
      groups.set(key, group);
    }
    const soldMs = Date.parse(record.soldAt);
    if (!Number.isFinite(soldMs) || soldMs <= startMs || soldMs > nowMs) group.outOfWindow += 1;
    else if (record.bundle === true) group.bundle += 1;
    else group.kept.push(record.priceCents);
  });

  const summaries: SoldSummary[] = [];
  for (const group of groups.values()) {
    const sorted = [...group.kept].sort((a, b) => a - b);
    const trimmed = trimOutliers(sorted, outlier);
    const outliers = sorted.length - trimmed.length;
    const sum = trimmed.reduce((acc, v) => acc + v, 0);
    const median = medianOf(trimmed);
    summaries.push({
      bucket: group.bucket,
      windowDays,
      n: trimmed.length,
      meanCents: trimmed.length === 0 ? null : Math.round(sum / trimmed.length),
      medianCents: median === null ? null : Math.round(median),
      outlierRule: outlier,
      excluded: { outOfWindow: group.outOfWindow, bundle: group.bundle, outlier: outliers },
      excludedTotal: group.outOfWindow + group.bundle + outliers
    });
  }

  return summaries.sort((a, b) => {
    const ka = bucketKey(a.bucket.graded, a.bucket.currency);
    const kb = bucketKey(b.bucket.graded, b.bucket.currency);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
