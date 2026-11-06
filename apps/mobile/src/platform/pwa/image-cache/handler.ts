import { IMAGE_ALLOWED_ORIGIN, IMAGE_CACHE_LIMITS } from '../../web-storage/contract';
import type { ImageEngine } from './engine';
import { readBounded } from './read-bounded';

export interface ImageHandlerDeps {
  engine: ImageEngine;
  fetchFn?: (input: string, init: RequestInit) => Promise<Response>;
  allowedOrigin?: string;
  perEntryMax?: number;
  /** Max clone bodies alive at once (being read + waiting). A response that finds no free slot is served network-only, never cloned. */
  maxAdmissions?: number;
}

export interface ImageHandler {
  /** Resolves with the response for the page. Cache work continues through `waitUntil`. */
  handle(request: Request, waitUntil: (p: Promise<unknown>) => void): Promise<Response>;
}

const isCacheable = (r: Response) => r.status === 200 && r.type !== 'opaque' && r.type !== 'opaqueredirect' && r.type !== 'error' && (r.headers.get('content-type') ?? '').toLowerCase().startsWith('image/');

export const IMAGE_ADMISSION_SLOTS = 2;

export function createImageHandler(deps: ImageHandlerDeps): ImageHandler {
  const { engine } = deps;
  const origin = deps.allowedOrigin ?? IMAGE_ALLOWED_ORIGIN;
  const cap = deps.perEntryMax ?? IMAGE_CACHE_LIMITS.perEntryMax;
  const doFetch = deps.fetchFn ?? ((input, init) => fetch(input, init));

  // ONE buffered read at a time; each buffer is <= cap bytes. Clones are only made while one of `slots` admission slots is free (taken
  // BEFORE response.clone()), so at most `slots` tee branches can sit unread, however many images the page loads at once.
  const slots = deps.maxAdmissions ?? IMAGE_ADMISSION_SLOTS;
  let slotsUsed = 0;
  let admissionTail: Promise<unknown> = Promise.resolve();
  let revalidating = false;

  /** Takes a slot, clones, queues the bounded read. Returns null (and clones nothing) when no slot is free. */
  function tryAdmit(url: string, response: Response): Promise<unknown> | null {
    if (slotsUsed >= slots) return null;
    slotsUsed++;
    let clone: Response;
    try {
      clone = response.clone();
    } catch {
      slotsUsed--;
      return null;
    }
    return admission(url, clone);
  }

  function admission(url: string, clone: Response): Promise<unknown> {
    const job = admissionTail.then(async () => {
      const read = await readBounded(clone, cap);
      if (!read.ok) return;
      await engine.admit({ url, body: read.body, contentType: clone.headers.get('content-type') ?? 'image/webp', etag: clone.headers.get('etag') ?? undefined });
    });
    admissionTail = job.catch(() => undefined);
    const done = job.catch(() => undefined).finally(() => { slotsUsed--; });
    return done;
  }

  const declaredTooBig = (r: Response) => {
    const declared = Number(r.headers.get('content-length'));
    return Number.isFinite(declared) && declared > cap; // a hint to skip work only; admission never trusts it
  };

  async function revalidate(url: string, etag: string | undefined): Promise<void> {
    if (revalidating) return; // at most one bounded background revalidation at a time
    revalidating = true;
    try {
      const headers: Record<string, string> = {};
      if (etag) headers['if-none-match'] = etag;
      const net = await doFetch(url, { mode: 'cors', credentials: 'omit', headers });
      if (net.status === 304) {
        await engine.markFresh(url);
        return;
      }
      if (isCacheable(net) && !declaredTooBig(net)) {
        const admitted = tryAdmit(url, net);
        if (admitted) await admitted;
        else void net.body?.cancel().catch(() => undefined); // busy: nothing cloned, nothing cached
      }
    } catch {
      // offline or network error: keep the stale entry, retry on a later view
    } finally {
      revalidating = false;
    }
  }

  return {
    async handle(request, waitUntil) {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.origin !== origin || request.headers.has('range')) return doFetch(request.url, { mode: 'cors', credentials: 'omit' }).catch(() => Response.error());

      const hit = await engine.lookup(url.href);
      if (hit) {
        waitUntil(engine.touch(url.href));
        if (hit.stale) waitUntil(revalidate(url.href, hit.etag));
        return hit.response;
      }

      let net: Response;
      try {
        net = await doFetch(url.href, { mode: 'cors', credentials: 'omit' });
      } catch {
        return Response.error(); // offline + never viewed: <img> onerror shows the styled placeholder
      }
      if (isCacheable(net) && !declaredTooBig(net)) {
        const admitted = tryAdmit(url.href, net); // no free slot: served network-only, no clone, no cache write
        if (admitted) waitUntil(admitted);
      }
      return net;
    }
  };
}
