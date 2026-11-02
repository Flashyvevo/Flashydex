// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyRequest, guardNonHtml, offlineResponse, OFFLINE_HTML, type RouteStrategy } from './routes';
import { createFetchRouter } from './sw-core';
import { createPrecache, manifestVersion, resolveEntries, PRECACHE_PREFIX } from './precache';
import { createImageEngine } from './image-cache/engine';
import { createImageHandler } from './image-cache/handler';
import { handleImageMessage } from './image-cache/messages';
import { createFakeCache, createFakeStore, plainLock, bytesOf } from './image-cache/test-fakes';

const ORIGIN = 'https://flashydex.example';
const precached = new Set([`${ORIGIN}/assets/index-abc.js`, `${ORIGIN}/assets/sqlite3-xyz.wasm`, `${ORIGIN}/assets/db.worker-1.js`, `${ORIGIN}/index.html`, `${ORIGIN}/icons/icon-192.png`]);
const ctx = { origin: ORIGIN, isPrecached: (u: string) => precached.has(u) };
const c = (url: string, over: Partial<{ method: string; mode: string; destination: string }> = {}) =>
  classifyRequest({ url, method: over.method ?? 'GET', mode: over.mode ?? 'cors', destination: over.destination ?? '' }, ctx);

describe('route classifier (WEB-STORAGE §7 order)', () => {
  const table: [string, string, Partial<{ method: string; mode: string; destination: string }>, RouteStrategy][] = [
    ['catalog manifest same-origin', `${ORIGIN}/catalog-manifest.json`, {}, 'network-only'],
    ['catalog manifest nested', `${ORIGIN}/x/catalog-manifest.json`, {}, 'network-only'],
    ['zst pack', `${ORIGIN}/packs/en.db.zst`, {}, 'network-only'],
    ['db file', `${ORIGIN}/catalog.db`, {}, 'network-only'],
    ['dev-packs', `${ORIGIN}/dev-packs/full/catalog-manifest.json`, {}, 'network-only'],
    ['dev-packs navigation is NOT html', `${ORIGIN}/dev-packs/foo`, { mode: 'navigate', destination: 'document' }, 'network-only'],
    ['packs host', 'https://flashydex-catalog-packs.netlify.app/anything', {}, 'network-only'],
    ['packs host manifest', 'https://flashydex-catalog-packs.netlify.app/catalog-manifest.json', {}, 'network-only'],
    ['cross-origin zst', 'https://github.com/x/releases/download/v1/en.zst', {}, 'network-only'],
    ['tcgdex api', 'https://api.tcgdex.net/v2/en/cards/base1-1', {}, 'network-only'],
    ['tcgdex image', 'https://assets.tcgdex.net/en/base/base1/1/low.webp', { destination: 'image', mode: 'no-cors' }, 'image-lru'],
    ['navigation root', `${ORIGIN}/`, { mode: 'navigate', destination: 'document' }, 'navigation'],
    ['navigation deep link', `${ORIGIN}/settings/data`, { mode: 'navigate', destination: 'document' }, 'navigation'],
    ['precached js', `${ORIGIN}/assets/index-abc.js`, { destination: 'script' }, 'precache'],
    ['precached wasm', `${ORIGIN}/assets/sqlite3-xyz.wasm`, {}, 'precache'],
    ['precached worker', `${ORIGIN}/assets/db.worker-1.js`, { destination: 'worker' }, 'precache'],
    ['precached icon', `${ORIGIN}/icons/icon-192.png`, { destination: 'image' }, 'precache'],
    ['missing worker', `${ORIGIN}/assets/new.worker-9.js`, { destination: 'worker' }, 'asset-network'],
    ['missing wasm', `${ORIGIN}/assets/gone.wasm`, {}, 'asset-network'],
    ['missing css', `${ORIGIN}/assets/gone.css`, { destination: 'style' }, 'asset-network'],
    ['sw.js untouched', `${ORIGIN}/sw.js`, {}, 'passthrough'],
    ['webmanifest untouched', `${ORIGIN}/manifest.webmanifest`, {}, 'passthrough'],
    ['POST', `${ORIGIN}/assets/index-abc.js`, { method: 'POST' }, 'passthrough'],
    ['unrelated cross-origin', 'https://fonts.example/x.woff2', {}, 'passthrough'],
    ['api path', `${ORIGIN}/api/thing`, {}, 'network-only']
  ];
  for (const [name, url, over, expected] of table) it(`${name} -> ${expected}`, () => expect(c(url, over)).toBe(expected));

  it('worker/WASM strategies can never produce the navigation strategy', () => {
    for (const [, url, over] of table) {
      if (over.destination === 'worker' || url.endsWith('.wasm')) expect(c(url, over)).not.toBe('navigation');
    }
  });
});

describe('guards', () => {
  it('turns an HTML answer for code into a 404', async () => {
    const r = guardNonHtml(new Response('<html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    expect(r.status).toBe(404);
    expect(guardNonHtml(new Response('x', { headers: { 'content-type': 'application/wasm' } })).status).toBe(200);
  });
  it('offline response is honest', async () => {
    const r = offlineResponse();
    expect(r.status).toBe(503);
    expect(OFFLINE_HTML).toContain('FlashyDex needs one online visit to finish installing');
  });
});

describe('precache', () => {
  function fakeStorage() {
    const stores = new Map<string, Map<string, Response>>();
    const storage = {
      async open(name: string) {
        if (!stores.has(name)) stores.set(name, new Map());
        const m = stores.get(name)!;
        return { match: async (k: string) => m.get(k)?.clone(), put: async (k: string, r: Response) => void m.set(k, r), keys: async () => [...m.keys()] };
      },
      async keys() {
        return [...stores.keys()];
      },
      async delete(name: string) {
        return stores.delete(name);
      }
    };
    return { storage: storage as unknown as CacheStorage, stores };
  }

  const entries = resolveEntries([{ url: 'index.html', revision: 'r1' }, 'assets/a-1.js', { url: 'assets/s.wasm', revision: null }], `${ORIGIN}/sw.js`);
  const fetchOk = async (r: Request) => new Response('body:' + r.url, { headers: { 'content-type': r.url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' } });

  it('install fills a versioned cache; activate deletes only older precache caches', async () => {
    const { storage, stores } = fakeStorage();
    stores.set(`${PRECACHE_PREFIX}old`, new Map());
    stores.set('flashydex-images-v1', new Map([['https://assets.tcgdex.net/x', new Response('x')]]));
    stores.set('someone-elses-cache', new Map());
    const p = createPrecache(entries, storage, fetchOk);
    await p.install();
    expect(p.cacheName).toBe(`${PRECACHE_PREFIX}${manifestVersion(entries)}`);
    expect((await p.match(`${ORIGIN}/assets/a-1.js`))?.status).toBe(200);
    const removed = await p.activate();
    expect(removed).toEqual([`${PRECACHE_PREFIX}old`]);
    expect([...stores.keys()].sort()).toEqual([p.cacheName, 'flashydex-images-v1', 'someone-elses-cache'].sort());
  });

  it('install fails (old SW keeps serving) on a 404 or on HTML for code', async () => {
    const { storage } = fakeStorage();
    await expect(createPrecache(entries, storage, async () => new Response('no', { status: 404 })).install()).rejects.toThrow(/precache failed/);
    await expect(createPrecache(entries, storage, async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })).install()).rejects.toThrow(/precache failed/);
  });

  it('manifest version changes with revisions', () => {
    const a = resolveEntries([{ url: 'index.html', revision: '1' }], ORIGIN);
    const b = resolveEntries([{ url: 'index.html', revision: '2' }], ORIGIN);
    expect(manifestVersion(a)).not.toBe(manifestVersion(b));
  });
});

describe('fetch router', () => {
  function build(opts: { images?: boolean; shell?: boolean; net?: (r: Request) => Promise<Response> } = {}) {
    const cache = createFakeCache({});
    const store = createFakeStore({});
    const engine = createImageEngine({ cache, store, lock: plainLock(), limits: { min: 100, default: 1000, max: 5000, perEntryMax: 400 }, touchDebounceMs: 0 });
    const net = opts.net ?? (async () => new Response('net', { headers: { 'content-type': 'text/plain' } }));
    const calls: string[] = [];
    const fetchFn = async (r: Request) => {
      calls.push(r.url);
      return net(r);
    };
    const entriesR = resolveEntries(['index.html', 'assets/a.js'], `${ORIGIN}/`);
    const map = new Map<string, Response>();
    if (opts.shell !== false) map.set(`${ORIGIN}/index.html`, new Response('SHELL', { headers: { 'content-type': 'text/html' } }));
    map.set(`${ORIGIN}/assets/a.js`, new Response('JS', { headers: { 'content-type': 'text/javascript' } }));
    const precache = {
      cacheName: 'x',
      has: (k: string) => entriesR.some((e) => e.key === k),
      install: async () => undefined,
      activate: async () => [],
      match: async (k: string) => map.get(k)?.clone()
    };
    const images = createImageHandler({ engine, fetchFn: async (url, init) => fetchFn(new Request(url, init)), perEntryMax: 400 });
    const router = createFetchRouter({ origin: ORIGIN, precache, images, fetchFn });
    const waits: Promise<unknown>[] = [];
    const run = (url: string, init: RequestInit & { mode?: RequestMode } = {}) => {
      // Node's Request rejects mode 'navigate', so build a minimal stand-in for navigations.
      const request = init.mode === ('navigate' as RequestMode) ? ({ url, method: 'GET', mode: 'navigate', destination: 'document', headers: new Headers() } as unknown as Request) : new Request(url, init);
      const out = router({ request, waitUntil: (p) => waits.push(p) });
      return out;
    };
    return { run, calls, waits, cache, store, engine };
  }

  it('navigation serves the shell and never hits the network', async () => {
    const t = build();
    const r = await t.run(`${ORIGIN}/settings/data`, { mode: 'navigate' } as RequestInit)!;
    expect(await r.text()).toBe('SHELL');
    expect(t.calls).toEqual([]);
  });

  it('navigation without a shell -> inline offline page, not a network HTML', async () => {
    const t = build({ shell: false });
    const r = await t.run(`${ORIGIN}/settings`, { mode: 'navigate' } as RequestInit)!;
    expect(r.status).toBe(503);
    expect(await r.text()).toContain('one online visit');
  });

  it('precached assets are served without network; a missing wasm answered with HTML becomes 404', async () => {
    const t = build({ net: async () => new Response('<html>shell</html>', { headers: { 'content-type': 'text/html' } }) });
    expect(await (await t.run(`${ORIGIN}/assets/a.js`)!).text()).toBe('JS');
    expect(t.calls).toEqual([]);
    const miss = await t.run(`${ORIGIN}/assets/missing.wasm`)!;
    expect(miss.status).toBe(404);
  });

  it('manifest/zst/api go to the network and are never stored anywhere', async () => {
    const t = build();
    for (const url of [`${ORIGIN}/dev-packs/catalog-manifest.json`, 'https://flashydex-catalog-packs.netlify.app/en.zst', 'https://api.tcgdex.net/v2/en/cards/x']) {
      const r = await t.run(url)!;
      expect(await r.text()).toBe('net');
    }
    expect(t.calls.length).toBe(3);
    expect(t.cache.map.size).toBe(0);
    expect(t.store.rows.size).toBe(0);
  });

  it('network failure for a pack propagates (no stale or HTML fallback)', async () => {
    const t = build({ net: async () => Promise.reject(new TypeError('offline')) });
    await expect(t.run(`${ORIGIN}/catalog-manifest.json`)!).rejects.toThrow('offline');
  });

  it('unrelated requests are not intercepted', () => {
    expect(build().run('https://elsewhere.example/x.png')).toBeNull();
  });
});

describe('image handler admission rules', () => {
  const URL_ = 'https://assets.tcgdex.net/en/base/base1/1/low.webp';
  function build(responder: () => Response | Promise<Response>) {
    const cache = createFakeCache({});
    const store = createFakeStore({});
    const engine = createImageEngine({ cache, store, lock: plainLock(), limits: { min: 100, default: 100_000, max: 500_000, perEntryMax: 400 }, touchDebounceMs: 0 });
    const seen: RequestInit[] = [];
    const handler = createImageHandler({
      engine,
      perEntryMax: 400,
      fetchFn: async (_u, init) => {
        seen.push(init);
        return responder();
      }
    });
    const waits: Promise<unknown>[] = [];
    const get = async (url = URL_) => {
      const res = await handler.handle(new Request(url, { mode: 'no-cors' }), (p) => waits.push(p));
      await Promise.all(waits.splice(0));
      return res;
    };
    return { get, cache, store, seen, engine };
  }
  const img = (n: number, headers: Record<string, string> = {}) => () => new Response(bytesOf(n), { status: 200, headers: { 'content-type': 'image/webp', ...headers } });

  it('caches a good webp, then serves the next view from cache (cors, credentials omit)', async () => {
    let net = 0;
    const t = build(() => (net++, img(100)()));
    expect((await t.get()).status).toBe(200);
    expect(t.seen[0]).toMatchObject({ mode: 'cors', credentials: 'omit' });
    expect(t.cache.map.size).toBe(1);
    const second = await t.get();
    expect((await second.arrayBuffer()).byteLength).toBe(100);
    expect(net).toBe(1);
  });

  it('passes through, uncached: 404, wrong type, oversized, lying Content-Length, huge declared length', async () => {
    const cases: [string, () => Response][] = [
      ['404', () => new Response('nope', { status: 404, headers: { 'content-type': 'image/webp' } })],
      ['html', () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })],
      ['oversized', img(401)],
      ['lying small CL', img(5000, { 'content-length': '5' })],
      ['declared huge', img(10, { 'content-length': '99999999' })]
    ];
    for (const [name, make] of cases) {
      const t = build(make);
      const res = await t.get();
      expect(res.status, name).toBeGreaterThan(0);
      expect(t.cache.map.size, name).toBe(0);
      expect(t.store.rows.size, name).toBe(0);
    }
  });

  it('opaque responses are never cached', async () => {
    const t = build(() => {
      const r = new Response(null, { status: 200 });
      Object.defineProperty(r, 'type', { value: 'opaque' });
      return r;
    });
    await t.get();
    expect(t.cache.map.size).toBe(0);
  });

  it('offline miss yields a network error response (styled placeholder path)', async () => {
    const t = build(() => Promise.reject(new TypeError('offline')));
    expect((await t.get()).type).toBe('error');
  });

  it('stale hit is served and revalidated once in the background', async () => {
    let t = 0;
    const cache = createFakeCache({});
    const store = createFakeStore({});
    const engine = createImageEngine({ cache, store, lock: plainLock(), limits: { min: 100, default: 100_000, max: 500_000, perEntryMax: 400 }, now: () => t, touchDebounceMs: 0 });
    let nets = 0;
    const handler = createImageHandler({ engine, perEntryMax: 400, fetchFn: async () => (nets++, img(120)()) });
    const waits: Promise<unknown>[] = [];
    const go = async () => {
      await handler.handle(new Request(URL_), (p) => waits.push(p));
      await Promise.all(waits.splice(0));
    };
    await go();
    expect(nets).toBe(1);
    t += 31 * 86_400_000;
    await go();
    expect(nets).toBe(2); // one revalidation
    expect(store.rows.get(URL_)?.storedAt).toBe(t);
    await go();
    expect(nets).toBe(2); // fresh again
  });

  it('ignores non-allowlisted origins and ranged requests (no caching)', async () => {
    const t = build(img(100));
    await t.get('https://evil.example/a.webp');
    expect(t.cache.map.size).toBe(0);
  });
});

describe('SW image messages', () => {
  const mk = () => createImageEngine({ cache: createFakeCache({}), store: createFakeStore({}), lock: plainLock(), limits: { min: 100, default: 1000, max: 5000, perEntryMax: 400 }, touchDebounceMs: 0 });
  it('stats / setLimit / clear reply with versioned ACKs', async () => {
    const e = mk();
    await e.admit({ url: 'https://assets.tcgdex.net/a/low.webp', body: bytesOf(300), contentType: 'image/webp' });
    expect(await handleImageMessage(e, { type: 'fdx:image-cache:stats', v: 1, id: 'a' })).toMatchObject({ type: 'fdx:ack', v: 1, id: 'a', ok: true, stats: { committedBytes: 300, enforced: true } });
    expect(await handleImageMessage(e, { type: 'fdx:image-cache:set-limit', v: 1, id: 'b', bytes: 1 })).toMatchObject({ ok: true, stats: { limitBytes: 100, committedBytes: 0 } });
    expect(await handleImageMessage(e, { type: 'fdx:image-cache:clear', v: 1, id: 'c' })).toMatchObject({ ok: true, stats: { entries: 0 } });
  });
  it('rejects unversioned or malformed requests and ignores other messages', async () => {
    const e = mk();
    expect(await handleImageMessage(e, { type: 'fdx:image-cache:stats', id: 'x' })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await handleImageMessage(e, { type: 'fdx:image-cache:set-limit', v: 1, id: 'x' })).toMatchObject({ ok: false });
    expect(await handleImageMessage(e, { type: 'SKIP_WAITING' })).toBeNull();
  });
});
