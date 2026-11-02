import { IMAGE_ALLOWED_ORIGIN, IMAGE_CACHE_LIMITS } from '../../web-storage/contract';
import type { ImageEngine } from './engine';
import { readBounded } from './read-bounded';

export interface ImageHandlerDeps {
  engine: ImageEngine;
  fetchFn?: (input: string, init: RequestInit) => Promise<Response>;
  allowedOrigin?: string;
  perEntryMax?: number;
}

export interface ImageHandler {
  /** Resolves with the response for the page. Cache work continues through `waitUntil`. */
  handle(request: Request, waitUntil: (p: Promise<unknown>) => void): Promise<Response>;
}

const isCacheable = (r: Response) => r.status === 200 && r.type !== 'opaque' && r.type !== 'opaqueredirect' && r.type !== 'error' && (r.headers.get('content-type') ?? '').toLowerCase().startsWith('image/');

export function createImageHandler(deps: ImageHandlerDeps): ImageHandler {
  const { engine } = deps;
  const origin = deps.allowedOrigin ?? IMAGE_ALLOWED_ORIGIN;
  const cap = deps.perEntryMax ?? IMAGE_CACHE_LIMITS.perEntryMax;
  const doFetch = deps.fetchFn ?? ((input, init) => fetch(input, init));

  // ONE buffered admission at a time; each buffer is <= cap bytes. Reads queue behind each other.
  let admissionTail: Promise<unknown> = Promise.resolve();
  let revalidating = false;

  function admitFrom(url: string, clone: Response): Promise<unknown> {
    const job = admissionTail.then(async () => {
      const read = await readBounded(clone, cap);
      if (!read.ok) return;
      await engine.admit({ url, body: read.body, contentType: clone.headers.get('content-type') ?? 'image/webp', etag: clone.headers.get('etag') ?? undefined });
    });
    admissionTail = job.catch(() => undefined);
    return job.catch(() => undefined);
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
      if (isCacheable(net) && !declaredTooBig(net)) await admitFrom(url, net.clone());
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
      if (isCacheable(net) && !declaredTooBig(net)) waitUntil(admitFrom(url.href, net.clone()));
      return net;
    }
  };
}
