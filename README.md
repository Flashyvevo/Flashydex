# pokescan

Self-hosted Pokémon TCG collection manager. This repository is a Phase 1 scaffold.

## Prerequisites

- Node.js 22.x and npm 10+
- Python 3.12 (`py -3.12` on Windows or `python3.12` on Linux)

## Setup

```bash
bash scripts/setup.sh
```

The setup script installs workspace dependencies, creates `services/recognition/.venv`, installs the recognition skeleton dependencies, and prints the LAN URL for a phone.

## Development

```bash
npm run dev
```

The web app listens on `0.0.0.0:3200`. Find LAN URLs again with:

```bash
bash scripts/lan-url.sh
```

## Commands

```bash
npm run typecheck
npm run lint
npm run test
npm run e2e
npm run build
npm run db:generate
npm run db:migrate
npm run sync -- --lang en,ja  # intentionally not implemented yet
```

`POKESCAN_DB_PATH` optionally overrides the SQLite path. It defaults to `./data/pokescan.db` relative to `apps/web` when running the web app.
