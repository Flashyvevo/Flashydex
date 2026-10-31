# FlashyDex

Local-first TCG collection manager and card scanner for iOS, Android, and the web. The collection and the card catalog live in
SQLite on the device; no server is required for normal use.

FlashyDex is not affiliated with Nintendo, Creatures, GAME FREAK, or The Pokémon Company.

## Layout

- `apps/mobile` - Vite + React 19 + Tailwind v4 + TanStack Router/Query, Capacitor 7 (`ios/`, `android/` committed)
- `packages/core` - framework-free domain layer (Drizzle schema, migrations, repositories, sync, import/export)
- `packages/schemas` - zod + JSON Schema contracts
- `tools/catalog-builder` - Node pipeline that crawls TCGdex and builds versioned catalog packs (`.db.zst`)
- `services/recognition` - optional Python 3.12 FastAPI service (health skeleton only for now)

## Prerequisites

Node 22+, npm 10+, Python 3.12 (only for the recognition tests).

## Quick start

```bash
npm install
bash scripts/setup.sh        # optional: recognition venv
npm run dev                  # Vite on 0.0.0.0:3200 -> http://<lan-ip>:3200
bash scripts/lan-url.sh      # prints the phone URL
```

The web build is a development/limited mode (SQLite runs in memory via sql.js). Native iOS/Android is the product.

## Catalog packs

```bash
# build one small EN pack (output: tools/catalog-builder/dist)
npm run catalog:build -- --lang en --sets swsh3

# copy built packs into apps/mobile/public/dev-packs with a dev manifest (dev server only)
npm run catalog:dev-pack
```

Full language: `npm run catalog:build -- --lang ja` (add `--resume` to continue an interrupted crawl). Other flags: `--sets a,b`,
`--out`, `--version YYYY.MM.DD.NNN`, `--cache-dir`, `--base-url`, `--concurrency 1..8`, `--max-cache-age-hours`, `--no-asset-check`.
The crawl cache and generated packs under `.agent/metrics/packs/` are gitignored.
Published packs come from the "Catalog packs" GitHub workflow (manual or weekly), which creates a `catalog-vYYYY.MM.DD` release.
Details: `docs/CATALOG-PACKS.md`, `docs/COMPRESSION-STORAGE.md`.

## Tests and checks

```bash
npm run typecheck
npm run lint
npm test            # core + mobile vitest, recognition pytest
npm run e2e         # Playwright against the dev server on :3200 (390x844 and 1280x800)
npm run build
```

## Native

```bash
npm run build && npx cap sync ios && npx cap open ios    # on a Mac
npm run cap:android
```

Mac/Xcode and on-device verification checklist: `scripts/ios-notes.md`.

## Phone testing over LAN (HTTPS)

Plain `http://<pc-ip>:3200` is a non-secure origin: the browser hides Web Locks, so the app opens **read-only** there (the tab lock cannot be taken). Use the HTTPS dev server instead:

```bash
npm run dev:https          # self-signed cert, https://<pc-ip>:3200
bash scripts/lan-url.sh    # prints your LAN IPs
```

On the phone open `https://<pc-ip>:3200`, accept the certificate warning once ("Show details → visit this website" in Safari; "Advanced → proceed" in Chrome). After that the origin is secure: writes, PWA install and (later) the camera work. Keep the tab in the foreground while it loads.
