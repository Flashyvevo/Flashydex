/** Live-scan retry policy (pure). A "scan session" = from opening the viewfinder until Scan Another / leaving the route. */

export const MAX_FAILED_ATTEMPTS = 3;
export const ATTEMPT_WINDOW_MS = 10_000;
export const MIN_ATTEMPT_GAP_MS = 1500;

/**
 * May a new frame be submitted now? `starts` = start times of attempts that counted (no_match/no_card or still in flight).
 * Never while in flight, ≥ 1.5 s after the previous start, and never more than 3 starts in any 10 s window (server limit is 30/min).
 */
export function attemptAllowed(starts: readonly number[], now: number, inFlight: boolean): boolean {
  if (inFlight) return false;
  const last = starts.length ? Math.max(...starts) : -Infinity;
  if (now - last < MIN_ATTEMPT_GAP_MS) return false;
  return starts.filter((t) => now - t < ATTEMPT_WINDOW_MS).length < MAX_FAILED_ATTEMPTS;
}

export const isNoMatch = (status: string): boolean => status === 'no_match' || status === 'no_card';
