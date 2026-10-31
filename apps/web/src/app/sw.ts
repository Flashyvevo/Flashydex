import { NetworkFirst, Serwist, StaleWhileRevalidate } from "serwist";

const precacheEntries = (
  self as typeof globalThis & {
    __SW_MANIFEST?: Array<string | { url: string; revision?: string | null }>;
  }
).__SW_MANIFEST;

const serwist = new Serwist({
  precacheEntries,
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching: [
    {
      matcher: ({ url }) => url.pathname.startsWith("/api/"),
      handler: new NetworkFirst({ cacheName: "api-cache" }),
    },
    {
      matcher: ({ url }) => url.hostname === "assets.tcgdex.net",
      handler: new StaleWhileRevalidate({ cacheName: "tcgdex-images" }),
    },
  ],
});

serwist.addEventListeners();
