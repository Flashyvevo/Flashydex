/** Optional startup timing: records a `performance.measure` named `name` around `fn` when the Performance API exists. */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const perf = (globalThis as { performance?: Performance }).performance;
  if (!perf || typeof perf.mark !== 'function' || typeof perf.measure !== 'function') return fn();
  const start = `${name}:start`;
  perf.mark(start);
  try {
    return await fn();
  } finally {
    try {
      perf.measure(name, start);
    } catch {
      /* timing must never break startup */
    }
  }
}
