import { IMAGE_ALLOWED_ORIGIN } from '../web-storage/contract';

/** WEB-STORAGE §7 route order, as a pure classifier so it can be table-tested. First match wins. */
export type RouteStrategy =
  | 'passthrough' // the SW does not call respondWith (browser default network path): non-GET, unrelated cross-origin, sw.js, manifest.webmanifest
  | 'network-only' // catalog manifest / packs / dev-packs / pack host / TCGdex JSON API: never cached, no HTML fallback
  | 'image-lru' // https://assets.tcgdex.net -> byte-bounded LRU
  | 'navigation' // same-origin navigate -> precached shell, else inline offline response
  | 'precache' // same-origin, precached URL -> cache-first by revision
  | 'asset-network'; // same-origin script/style/worker/wasm/font that is NOT precached -> network, and never HTML

export const PACKS_HOST = 'https://flashydex-catalog-packs.netlify.app';
export const TCGDEX_API_HOST = 'https://api.tcgdex.net';

export interface RouteInput {
  url: string;
  method: string;
  mode: string; // Request.mode
  destination?: string; // Request.destination
}

export interface RouteContext {
  /** SW origin (self.location.origin). */
  origin: string;
  /** Absolute URLs (no hash) of precached assets. */
  isPrecached(url: string): boolean;
}

const PACK_PATH = /(^|\/)catalog-manifest\.json$|\.(zst|db)$/i;
const ASSET_EXT = /\.(m?js|css|wasm|woff2?|ttf|otf|map)$/i;
const ASSET_DEST = new Set(['script', 'style', 'worker', 'sharedworker', 'font', 'serviceworker', 'audioworklet']);

export function classifyRequest(input: RouteInput, ctx: RouteContext): RouteStrategy {
  if (input.method !== 'GET') return 'passthrough';
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return 'passthrough';
  }
  const sameOrigin = url.origin === ctx.origin;
  // (1) catalog packs/manifests: network only on EVERY host (same-origin dev packs included)
  if (url.origin === PACKS_HOST || PACK_PATH.test(url.pathname) || url.pathname.startsWith('/dev-packs/')) return 'network-only';
  // (2) TCGdex JSON API
  if (url.origin === TCGDEX_API_HOST) return 'network-only';
  // (3) card art
  if (url.origin === IMAGE_ALLOWED_ORIGIN) return 'image-lru';
  if (!sameOrigin) return 'passthrough';
  // never touch the SW script itself, the manifest or API-ish paths
  if (url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest') return 'passthrough';
  if (url.pathname.startsWith('/api/')) return 'network-only';
  // (4) navigations
  if (input.mode === 'navigate') return 'navigation';
  // (5) precached hashed assets, else guarded network for code-like requests
  const key = `${url.origin}${url.pathname}`;
  if (ctx.isPrecached(key)) return 'precache';
  if (ASSET_EXT.test(url.pathname) || (input.destination !== undefined && ASSET_DEST.has(input.destination))) return 'asset-network';
  return 'passthrough';
}

export const OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>FlashyDex</title><style>body{font:16px system-ui,sans-serif;background:#101114;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}</style></head>' +
  '<body><main><h1>FlashyDex needs one online visit to finish installing</h1><p>Connect to the internet and reload. After that it works offline.</p></main></body></html>';

export function offlineResponse(): Response {
  return new Response(OFFLINE_HTML, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

/** A request for code/worker/WASM must never be answered with the SPA's index.html (hosting rewrites return 200 HTML for misses). */
export function guardNonHtml(response: Response): Response {
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  if (type.startsWith('text/html')) return new Response(null, { status: 404, statusText: 'Not Found' });
  return response;
}
