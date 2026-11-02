/**
 * FlashyDex service worker (vite-plugin-pwa `strategies: 'injectManifest'`, output /sw.js at scope '/').
 *
 * Typing note: the app tsconfig uses the DOM lib; the `webworker` lib conflicts with it, so the few worker-only globals this file
 * touches are declared below instead of `/// <reference lib="webworker" />`. All real logic lives in DOM-free modules next to it
 * (routes, precache, sw-core, image-cache/*) that vitest drives directly.
 *
 * Lifecycle rules (WEB-STORAGE §7): NO skipWaiting on install, NO unconditional clients.claim(); skipWaiting only on the page's
 * SKIP_WAITING message; activate deletes only this SW's own outdated precache caches.
 */
import { IMAGE_CACHE_LIMITS, IMAGE_CACHE_NAME, SW_MESSAGES } from '../web-storage/contract';
import { createImageEngine } from './image-cache/engine';
import { createImageHandler } from './image-cache/handler';
import { createCacheStorageAdapter, createIdbLedger, createWebLock } from './image-cache/idb-ledger';
import { handleImageMessage, isImageMessage } from './image-cache/messages';
import { createPrecache, resolveEntries, type PrecacheEntry } from './precache';
import { createFetchRouter } from './sw-core';

interface ExtendableEventLike extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface MessageEventLike extends ExtendableEventLike {
  readonly data: unknown;
  readonly ports: readonly MessagePort[];
}
interface SWScope {
  __WB_MANIFEST: PrecacheEntry[];
  location: Location;
  caches: CacheStorage;
  registration: { active: unknown };
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', l: (e: ExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', l: (e: FetchEventLike) => void): void;
  addEventListener(type: 'message', l: (e: MessageEventLike) => void): void;
}
declare const self: SWScope;

const entries = resolveEntries(self.__WB_MANIFEST, self.location.href);
const precache = createPrecache(entries, self.caches);

const engine = createImageEngine({
  cache: createCacheStorageAdapter(IMAGE_CACHE_NAME, self.caches),
  store: createIdbLedger(),
  lock: createWebLock(),
  limits: IMAGE_CACHE_LIMITS
});
const router = createFetchRouter({ origin: self.location.origin, precache, images: createImageHandler({ engine }) });

// Reconcile at worker start (pending/untracked entries removed before any admission).
void engine.reconcile();

let firstInstall = false;

self.addEventListener('install', (event) => {
  firstInstall = self.registration.active === null || self.registration.active === undefined;
  event.waitUntil(precache.install()); // a failure rejects install: the previous SW (if any) keeps serving
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await precache.activate(); // only `flashydex-precache-*` caches that are not ours; never images, IDB, OPFS or other namespaces
      await engine.reconcile();
      // Claim only on the very first install (no previous worker, so there is no old app to cut over). Updates wait for the page.
      if (firstInstall) await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const response = router(event);
  if (response) event.respondWith(response);
});

self.addEventListener('message', (event) => {
  const data = event.data as { type?: unknown } | null;
  if (data && (data.type === SW_MESSAGES.skipWaiting || data.type === 'fdx:sw:skip-waiting')) {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (!isImageMessage(data)) return;
  const port = event.ports[0];
  event.waitUntil(
    handleImageMessage(engine, data).then((ack) => {
      if (ack && port) port.postMessage(ack);
    })
  );
});
