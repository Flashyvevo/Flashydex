# FlashyDex

Local-first TCG collection manager for iOS, Android, and the web. The app keeps its catalog and collection data in SQLite on the device; no server is required for normal use.

## Prerequisites

- Node.js 22 or newer (`.nvmrc` is 22)
- npm 10 or newer
- Python 3.12 for the recognition-service health skeleton

## Setup

```bash
npm install
bash scripts/setup.sh
```

`npm install` copies the web SQLite WASM asset and generates abstract FlashyDex PWA icons. The setup script uses `npm ci` when a lockfile is present, then creates `services/recognition/.venv`.

## Development

```bash
npm run dev
```

Vite listens on `0.0.0.0:3200` for LAN testing. Print a phone URL with:

```bash
bash scripts/lan-url.sh
```

## Commands

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run e2e
npm run cap:sync
npm run cap:ios
npm run cap:android
npm run db:generate
```

The web SQLite implementation uses `jeep-sqlite` and sql.js. Native builds use `@capacitor-community/sqlite`; run `npm run cap:sync` after every web build before opening the native projects. See `scripts/ios-notes.md` for the Mac/Xcode steps.

FlashyDex is not affiliated with Nintendo, Creatures, GAME FREAK, or The Pokémon Company.
