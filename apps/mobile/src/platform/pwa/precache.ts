/**
 * Hand-rolled precache for vite-plugin-pwa injectManifest (no workbox runtime dependency).
 * One versioned cache per manifest. Activation deletes ONLY older `flashydex-precache-*` caches.
 */
export type PrecacheEntry = string | { url: string; revision?: string | null };

export const PRECACHE_PREFIX = 'flashydex-precache-';

export interface ResolvedEntry {
  /** Absolute URL, no hash/search. */
  key: string;
  /** Same URL; revision non-null => bypass the HTTP cache when fetching. */
  revision: string | null;
}

export function resolveEntries(entries: readonly PrecacheEntry[], base: string): ResolvedEntry[] {
  const seen = new Map<string, ResolvedEntry>();
  for (const entry of entries) {
    const raw = typeof entry === 'string' ? entry : entry.url;
    const revision = typeof entry === 'string' ? null : (entry.revision ?? null);
    const u = new URL(raw, base);
    u.hash = '';
    seen.set(`${u.origin}${u.pathname}`, { key: `${u.origin}${u.pathname}`, revision });
  }
  return [...seen.values()];
}

/** Small stable (non-cryptographic) hash: cache name only needs to differ between manifests. */
export function manifestVersion(entries: readonly ResolvedEntry[]): string {
  const text = [...entries].map((e) => `${e.key}@${e.revision ?? ''}`).sort().join('\n');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export interface Precache {
  readonly cacheName: string;
  has(key: string): boolean;
  install(): Promise<void>;
  activate(): Promise<string[]>;
  match(key: string): Promise<Response | undefined>;
}

export function createPrecache(entries: readonly ResolvedEntry[], storage: CacheStorage, fetchFn: (r: Request) => Promise<Response> = (r) => fetch(r)): Precache {
  const cacheName = `${PRECACHE_PREFIX}${manifestVersion(entries)}`;
  const keys = new Set(entries.map((e) => e.key));
  return {
    cacheName,
    has: (key) => keys.has(key),
    async install() {
      const cache = await storage.open(cacheName);
      for (const entry of entries) {
        if (await cache.match(entry.key)) continue; // same manifest version, already complete for this URL
        const request = new Request(entry.key, entry.revision ? { cache: 'reload' } : {});
        const response = await fetchFn(request);
        const htmlForCode = /\.(m?js|css|wasm|woff2?|png|svg|ico|webmanifest)$/i.test(entry.key) && (response.headers.get('content-type') ?? '').startsWith('text/html');
        if (!response.ok || htmlForCode) {
          throw new Error(`precache failed for ${entry.key}: ${response.status}`); // aborts install, old SW stays in charge
        }
        // A redirected response cannot be served to a navigation; rebuild it as a clean one.
        const clean = response.redirected ? new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers: response.headers }) : response;
        await cache.put(entry.key, clean);
      }
    },
    async activate() {
      const removed: string[] = [];
      for (const name of await storage.keys()) {
        if (name.startsWith(PRECACHE_PREFIX) && name !== cacheName) {
          if (await storage.delete(name)) removed.push(name);
        }
      }
      return removed;
    },
    async match(key) {
      const cache = await storage.open(cacheName);
      return cache.match(key);
    }
  };
}
