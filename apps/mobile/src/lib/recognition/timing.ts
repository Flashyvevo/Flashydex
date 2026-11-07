/** Last-scan timings (Stage 10): kept in memory + sessionStorage, exposed as `fdx:scan-*` performance measures for Diagnostics. */
export type ScanTimings = { prepareMs: number; uploadMs: number | null; networkMs: number | null; serverMs: number | null; totalMs: number; originalBytes: number; uploadBytes: number; width: number; height: number; status: string };

const KEY = 'fdx:last-scan';
let last: ScanTimings | null = null;

export function recordScan(t: ScanTimings): void {
  last = t;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return;
  const end = performance.now();
  const add = (name: string, ms: number | null, startOffset: number) => {
    if (ms === null) return;
    try {
      performance.measure(`fdx:scan-${name}`, { start: Math.max(0, end - t.totalMs + startOffset), duration: ms });
    } catch {
      /* measure unsupported */
    }
  };
  add('prepare', t.prepareMs, 0);
  add('network', t.networkMs, t.prepareMs);
  add('server', t.serverMs, t.prepareMs);
  add('total', t.totalMs, 0);
}

export function getLastScan(): ScanTimings | null {
  if (last) return last;
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ScanTimings) : null;
  } catch {
    return null;
  }
}

const ms = (n: number | null): string => (n === null ? '—' : `${Math.round(n)} ms`);
const secs = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

export function formatLastScan(t: ScanTimings): string {
  return `prepare ${ms(t.prepareMs)} · network ${ms(t.networkMs)} · server ${ms(t.serverMs)} · total ${secs(t.totalMs)}`;
}
