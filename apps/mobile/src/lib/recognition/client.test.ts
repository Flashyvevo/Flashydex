import { describe, expect, it, vi } from 'vitest';
import { checkScannerOnline, identify, langHint, mapHttpFailure, suggestVariant, type IdentifyResult } from './client';
import { failureCopy } from './copy';

const candidate = { language: 'en', cardId: 'swsh3-136', localId: '136', name: 'Furret', setId: 'swsh3', setName: 'Darkness Ablaze', imageUrl: 'https://assets.tcgdex.net/en/swsh/swsh3/136/low.webp', score: 0.92, signals: { hash: 0.9, embed: 0.9, ocr: 1, symbol: null }, variantHints: {} };
const okBody = { status: 'match', confidence: 0.93, candidates: [candidate], timingMs: { total: 321.5 }, indexVersion: 'v1' };
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const err = (status: number, code: string, headers?: Record<string, string>, retryable = true) => res(status, { error: { code, message: code, retryable } }, headers);
const file = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });

async function run(fetches: Array<() => Response | Promise<Response>>, opts: Partial<Parameters<typeof identify>[1]> = {}): Promise<{ r: IdentifyResult; fetchMock: ReturnType<typeof vi.fn> }> {
  const fetchMock = vi.fn(async () => {
    const next = fetches.shift();
    if (!next) throw new Error('no more mocked responses');
    return next();
  });
  const r = await identify(file, { lang: 'en', ...opts }, { fetch: fetchMock as unknown as typeof fetch });
  return { r, fetchMock };
}
const kind = (r: IdentifyResult) => (r.ok ? 'ok' : r.failure.kind);

describe('identify', () => {
  it('accepts the real service null variant hints', async () => {
    const nullHints = { ...okBody, candidates: [{ ...candidate, variantHints: { reverseHolo: null, firstEdition: null, stamp: null } }] };
    const { r } = await run([() => res(200, nullHints)]);
    expect(r.ok).toBe(true);
  });
  it('posts multipart to same-origin /api/identify with no Authorization header and omits credentials', async () => {
    const { r, fetchMock } = await run([() => res(200, okBody)], { lang: 'ja', maxCandidates: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.candidates[0]?.cardId).toBe('swsh3-136');
      expect(r.timing.serverMs).toBe(321.5);
    }
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/identify');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    const form = init.body as FormData;
    expect(form.get('lang')).toBe('ja');
    expect(form.get('max_candidates')).toBe('2');
    expect(form.get('image')).toBeInstanceOf(Blob);
  });

  it.each([
    [413, 'PAYLOAD_TOO_LARGE', 'too_large'],
    [415, 'UNSUPPORTED_IMAGE', 'unsupported_image'],
    [503, 'RECOGNIZER_BUSY', 'busy'],
    [429, 'RATE_LIMITED', 'rate_limited'],
    [502, 'RECOGNIZER_OFFLINE', 'offline'],
    [504, 'RECOGNIZER_TIMEOUT', 'timeout'],
    [401, 'UNAUTHORIZED', 'offline'],
    [503, 'BUSY', 'busy'],
    [503, 'INDEX_NOT_READY', 'index_unavailable'],
    [503, 'MODEL_MISSING', 'model_unavailable'],
    [413, 'IMAGE_TOO_LARGE', 'too_large'],
    [415, 'HEIC_UNSUPPORTED', 'unsupported_image'],
    [521, 'X', 'offline'],
    [530, 'X', 'offline'],
    [504, 'X', 'timeout'],
    [418, 'TEAPOT', 'unknown']
  ])('maps HTTP %i %s → %s', async (status, code, expected) => {
    const { r } = await run([() => err(status, code)]);
    expect(kind(r)).toBe(expected);
  });

  it('unknown codes carry the body retryable flag', async () => {
    const { r } = await run([() => err(418, 'TEAPOT', undefined, false)]);
    expect(r).toEqual({ ok: false, failure: { kind: 'unknown', status: 418, code: 'TEAPOT', retryable: false } });
  });
  it('reads Retry-After seconds on 429', async () => {
    const { r } = await run([() => err(429, 'RATE_LIMITED', { 'Retry-After': '7' })]);
    expect(r).toEqual({ ok: false, failure: { kind: 'rate_limited', retryAfterS: 7 } });
    expect(failureCopy((r as unknown as { failure: never }).failure).body).toContain('7 seconds');
  });
  it('429 without header → null wait', () => {
    expect(mapHttpFailure(429, null, null)).toEqual({ kind: 'rate_limited', retryAfterS: null });
  });
  it('HEIC flag is set only for HEIC_UNSUPPORTED', () => {
    expect(mapHttpFailure(415, 'HEIC_UNSUPPORTED', null)).toEqual({ kind: 'unsupported_image', heic: true });
    expect(mapHttpFailure(415, 'UNSUPPORTED_IMAGE', null)).toEqual({ kind: 'unsupported_image', heic: false });
  });
  it('busy is not retried automatically (the UI offers Try again)', async () => {
    const { r, fetchMock } = await run([() => err(503, 'RECOGNIZER_BUSY')]);
    expect(kind(r)).toBe('busy');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('fetch TypeError → offline', async () => {
    const { r } = await run([() => { throw new TypeError('Failed to fetch'); }]);
    expect(kind(r)).toBe('offline');
  });
  it('schema mismatch → bad_response; invalid JSON → bad_response', async () => {
    expect(kind((await run([() => res(200, { status: 'nope' })])).r)).toBe('bad_response');
    expect(kind((await run([() => res(200, '<html>')])).r)).toBe('bad_response');
  });
  it('timeout aborts a hanging request', async () => {
    const fetchMock = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
    const r = await identify(file, { lang: 'any', timeoutMs: 30 }, { fetch: fetchMock as unknown as typeof fetch });
    expect(kind(r)).toBe('timeout');
  });
  it('caller cancel → cancelled', async () => {
    const ctl = new AbortController();
    const fetchMock = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
    const p = identify(file, { lang: 'any', signal: ctl.signal }, { fetch: fetchMock as unknown as typeof fetch });
    setTimeout(() => ctl.abort(), 10);
    expect(kind(await p)).toBe('cancelled');
  });
  it('already-aborted signal → cancelled without a request', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { r, fetchMock } = await run([() => res(200, okBody)], { signal: ctl.signal });
    expect(kind(r)).toBe('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('checkScannerOnline', () => {
  it('true on 200 {ok:true}; false on non-2xx, ok:false, or network error', async () => {
    expect(await checkScannerOnline((async () => res(200, { ok: true })) as unknown as typeof fetch)).toBe(true);
    expect(await checkScannerOnline((async () => res(200, { ok: false })) as unknown as typeof fetch)).toBe(false);
    expect(await checkScannerOnline((async () => res(502, {})) as unknown as typeof fetch)).toBe(false);
    expect(await checkScannerOnline((async () => { throw new TypeError('x'); }) as unknown as typeof fetch)).toBe(false);
  });
});

describe('langHint', () => {
  it('maps installed catalogs', () => {
    expect(langHint(true, false)).toBe('en');
    expect(langHint(false, true)).toBe('ja');
    expect(langHint(true, true)).toBe('any');
    expect(langHint(false, false)).toBe('any');
  });
});

describe('suggestVariant', () => {
  it('needs ≥ 0.6 and a listed variant', () => {
    expect(suggestVariant({ reverseHolo: 0.8 }, ['normal', 'reverse_holo'])).toBe('reverse_holo');
    expect(suggestVariant({ reverseHolo: 0.59 }, ['normal', 'reverse_holo'])).toBeNull();
    expect(suggestVariant({ reverseHolo: 0.9 }, ['normal', 'holo'])).toBeNull();
    expect(suggestVariant({ firstEdition: 0.9, stamp: 0.7 }, ['normal', 'promo_stamped'])).toBe('promo_stamped');
    expect(suggestVariant({ firstEdition: 0.7, reverseHolo: 0.65 }, ['normal', 'first_edition', 'reverse_holo'])).toBe('first_edition');
    expect(suggestVariant(undefined, ['normal'])).toBeNull();
    expect(suggestVariant({}, ['normal'])).toBeNull();
    expect(suggestVariant({ reverseHolo: null, firstEdition: null, stamp: null }, ['normal', 'reverse_holo'])).toBeNull();
  });
});

describe('failureCopy', () => {
  it('busy copy is the contract message', () => {
    expect(failureCopy({ kind: 'busy' }).body).toBe('The scanner is busy — try again in a moment.');
  });
  it('offline keeps manual add available', () => {
    expect(failureCopy({ kind: 'offline' }).body).toContain('search or browse');
  });
  it('heic message', () => {
    const c = failureCopy({ kind: 'unsupported_image', heic: true }).body;
    expect(c).toContain('Choose a JPEG');
    expect(c).toContain('Most Compatible');
  });
});
