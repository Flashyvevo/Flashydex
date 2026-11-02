import { classifyRequest, guardNonHtml, offlineResponse } from './routes';
import type { ImageHandler } from './image-cache/handler';
import type { Precache } from './precache';

export interface FetchRouterDeps {
  origin: string;
  precache: Precache;
  images: ImageHandler;
  fetchFn?: (request: Request) => Promise<Response>;
}

export interface FetchRouterEvent {
  request: Request;
  waitUntil(p: Promise<unknown>): void;
}

/**
 * The SW fetch decision, free of ServiceWorkerGlobalScope so vitest can drive it. Returns null for "do not respondWith".
 * Never caches at runtime except through the image handler; never returns HTML for code/worker/WASM.
 */
export function createFetchRouter(deps: FetchRouterDeps): (event: FetchRouterEvent) => Promise<Response> | null {
  const doFetch = deps.fetchFn ?? ((r: Request) => fetch(r));
  const ctx = { origin: deps.origin, isPrecached: (key: string) => deps.precache.has(key) };
  const shellKey = `${deps.origin}/index.html`;

  return (event) => {
    const { request } = event;
    const strategy = classifyRequest({ url: request.url, method: request.method, mode: request.mode, destination: request.destination }, ctx);
    switch (strategy) {
      case 'passthrough':
        return null;
      case 'network-only':
        return doFetch(request); // errors propagate as a network error: no stale body, no HTML fallback
      case 'image-lru':
        return deps.images.handle(request, (p) => event.waitUntil(p));
      case 'navigation':
        return (async () => {
          const shell = await deps.precache.match(shellKey).catch(() => undefined);
          return shell ?? offlineResponse();
        })();
      case 'precache':
        return (async () => {
          const url = new URL(request.url);
          const hit = await deps.precache.match(`${url.origin}${url.pathname}`).catch(() => undefined);
          if (hit) return hit;
          return guardNonHtml(await doFetch(request));
        })();
      case 'asset-network':
        return doFetch(request).then(guardNonHtml);
    }
  };
}
