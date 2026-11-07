import { RecognitionResponse } from '@flashydex/core';

export type { RecognitionResponse };
export type RecognitionCandidate = RecognitionResponse['candidates'][number];

export type RecognitionFailure =
  | { kind: 'offline'; status?: number }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'rate_limited'; retryAfterS: number | null }
  | { kind: 'busy' }
  | { kind: 'index_unavailable' }
  | { kind: 'model_unavailable' }
  | { kind: 'too_large' }
  | { kind: 'unsupported_image'; heic: boolean; detail?: string; reason?: string }
  | { kind: 'bad_response' }
  /** Any error code this client doesn't know (e.g. added by a newer service): handled generically. */
  | { kind: 'unknown'; status: number; code: string | null; retryable: boolean };
export type FailureKind = RecognitionFailure['kind'];

export type IdentifyTiming = { uploadMs: number; networkMs: number; serverMs: number | null };
export type IdentifyResult = { ok: true; response: RecognitionResponse; timing: IdentifyTiming } | { ok: false; failure: RecognitionFailure };

export const IDENTIFY_URL = '/api/identify';
export const HEALTH_URL = '/api/recognizer/health';
export const IDENTIFY_TIMEOUT_MS = 12_000;
const TUNNEL_DOWN = new Set([502, 521, 522, 523, 530, 1033]);

/** Test hook: `window.__FDX_RECOG_TIMEOUT_MS__` shortens the 12 s timeout in e2e. */
function timeoutOverride(): number | null {
  const v = (globalThis as { __FDX_RECOG_TIMEOUT_MS__?: unknown }).__FDX_RECOG_TIMEOUT_MS__;
  return typeof v === 'number' && v > 0 ? v : null;
}

/** Pure mapping of a non-2xx response → failure. `code`/`retryable` come from the `{error:{code,message,retryable}}` body when parseable. Understands the contract codes and the raw service codes. */
export function mapHttpFailure(status: number, code: string | null, retryAfterHeader: string | null, retryable = true): RecognitionFailure {
  if (status === 429 || code === 'RATE_LIMITED') {
    const n = retryAfterHeader === null ? NaN : Number.parseFloat(retryAfterHeader);
    return { kind: 'rate_limited', retryAfterS: Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null };
  }
  if (code === 'RECOGNIZER_BUSY' || (status === 503 && code === 'BUSY')) return { kind: 'busy' };
  if (status === 503 && code === 'INDEX_NOT_READY') return { kind: 'index_unavailable' };
  if (status === 503 && code === 'MODEL_MISSING') return { kind: 'model_unavailable' };
  // UNAUTHORIZED = proxy token misconfiguration → shown as offline (contract).
  if (code === 'RECOGNIZER_OFFLINE' || code === 'UNAUTHORIZED') return { kind: 'offline', status };
  if (code === 'RECOGNIZER_TIMEOUT') return { kind: 'timeout' };
  if (status === 413 || code === 'PAYLOAD_TOO_LARGE' || code === 'IMAGE_TOO_LARGE') return { kind: 'too_large' };
  if (status === 415 || code === 'UNSUPPORTED_IMAGE' || code === 'UNSUPPORTED_IMAGE_TYPE' || code === 'HEIC_UNSUPPORTED') return { kind: 'unsupported_image', heic: code === 'HEIC_UNSUPPORTED' };
  if (code === 'INVALID_IMAGE') return { kind: 'unsupported_image', heic: false, detail: 'invalid' };
  if (status === 401 || status === 403) return { kind: 'offline', status };
  if (TUNNEL_DOWN.has(status)) return { kind: 'offline', status };
  if (status === 504 || status === 524) return { kind: 'timeout' };
  return { kind: 'unknown', status, code, retryable };
}

async function errorBodyOf(res: Response): Promise<{ code: string | null; retryable: boolean }> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; retryable?: unknown } };
    return { code: typeof body?.error?.code === 'string' ? body.error.code : null, retryable: body?.error?.retryable !== false };
  } catch {
    return { code: null, retryable: true };
  }
}

type Deps = { fetch?: typeof fetch; now?: () => number };

export type IdentifyOptions = { lang: 'en' | 'ja' | 'any'; maxCandidates?: number; signal?: AbortSignal; timeoutMs?: number };

/** POST same-origin `/api/identify`. No Authorization header, no runtime URL: the proxy (Netlify function / Vite dev proxy) owns the upstream. Never throws. */
export async function identify(file: Blob, opts: IdentifyOptions, deps: Deps = {}): Promise<IdentifyResult> {
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? (() => performance.now());
  const timeoutMs = opts.timeoutMs ?? timeoutOverride() ?? IDENTIFY_TIMEOUT_MS;

  const ctl = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const onCaller = () => {
    cancelled = true;
    ctl.abort();
  };
  if (opts.signal?.aborted) return { ok: false, failure: { kind: 'cancelled' } };
  opts.signal?.addEventListener('abort', onCaller);
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  const abortFailure = (): RecognitionFailure => (cancelled ? { kind: 'cancelled' } : { kind: 'timeout' });

  try {
    const form = new FormData();
    form.append('image', file, 'photo.jpg');
    form.append('lang', opts.lang);
    form.append('max_candidates', String(opts.maxCandidates ?? 3));
    const t0 = now();
    let res: Response;
    try {
      res = await doFetch(IDENTIFY_URL, { method: 'POST', body: form, signal: ctl.signal, credentials: 'omit' });
    } catch (error) {
      if (ctl.signal.aborted || timedOut || cancelled || (error as { name?: string })?.name === 'AbortError') return { ok: false, failure: abortFailure() };
      return { ok: false, failure: { kind: 'offline' } };
    }
    const uploadMs = now() - t0;

    if (!res.ok) {
      const body = await errorBodyOf(res);
      return { ok: false, failure: mapHttpFailure(res.status, body.code, res.headers.get('Retry-After'), body.retryable) };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, failure: ctl.signal.aborted ? abortFailure() : { kind: 'bad_response' } };
    }
    const networkMs = now() - t0;
    const parsed = RecognitionResponse.safeParse(json);
    if (!parsed.success) return { ok: false, failure: { kind: 'bad_response' } };
    const total = parsed.data.timingMs.total;
    return { ok: true, response: parsed.data, timing: { uploadMs, networkMs, serverMs: typeof total === 'number' ? total : null } };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCaller);
  }
}

/** One-shot, non-blocking health probe for the "Scanner offline" banner (3 s timeout). Never throws. */
export async function checkScannerOnline(fetchFn: typeof fetch = fetch, timeoutMs = 3000): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(HEALTH_URL, { signal: ctl.signal, cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: unknown; status?: unknown; ready?: unknown } | null;
    if (!body) return false;
    return !(body.ok === false || body.status === 'degraded' || body.ready === false);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Language hint from the installed catalogs: only EN → 'en', only JA → 'ja', both/none → 'any'. */
export function langHint(enInstalled: boolean, jaInstalled: boolean): 'en' | 'ja' | 'any' {
  if (enInstalled && !jaInstalled) return 'en';
  if (jaInstalled && !enInstalled) return 'ja';
  return 'any';
}

/** Variant hint rule (Stage 8): a recognition hint pre-selects a variant only at confidence ≥ 0.6 and only if the catalog lists it. */
export function suggestVariant(
  hints: { reverseHolo?: number | null | undefined; firstEdition?: number | null | undefined; stamp?: number | null | undefined } | undefined,
  available: readonly string[]
): 'reverse_holo' | 'first_edition' | 'promo_stamped' | null {
  if (!hints) return null;
  const options: Array<['reverse_holo' | 'first_edition' | 'promo_stamped', number | null | undefined]> = [
    ['first_edition', hints.firstEdition],
    ['promo_stamped', hints.stamp],
    ['reverse_holo', hints.reverseHolo]
  ];
  let best: { v: 'reverse_holo' | 'first_edition' | 'promo_stamped'; c: number } | null = null;
  for (const [v, c] of options) if (c != null && c >= 0.6 && available.includes(v) && (!best || c > best.c)) best = { v, c };
  return best?.v ?? null;
}
