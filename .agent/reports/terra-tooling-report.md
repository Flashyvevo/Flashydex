# Terra tooling report

## Produced

- Root npm-workspace scaffold, bash setup/LAN/sync/test utilities, CI workflow, editor/npm metadata, README, and third-party-notice placeholder.
- `apps/web`: Next.js 15 App Router scaffold, TypeScript/Tailwind/PostCSS/ESLint/Vitest/Playwright/Drizzle configs, Serwist worker, manifest, generated non-copyrighted 192px and 512px PNG icons, SQLite/Drizzle client, zod env parser, and minimal `pokescan` page.
- `packages/schemas`: placeholder package with build/typecheck wiring.
- `services/recognition`: Python 3.12 FastAPI health skeleton and pytest.

## Exact primary versions

- Next.js `15.5.28` (latest in the required Next 15 major)
- drizzle-orm `0.45.4`
- better-sqlite3 `13.0.3`
- @serwist/next and serwist `9.5.13`
- Tailwind CSS / @tailwindcss/postcss `4.3.3`
- React / react-dom `19.3.1`
- TypeScript `5.9.3`, Vitest `3.2.4`, Playwright `1.64.1`
- FastAPI `0.128.8`, Uvicorn `0.40.0`, pytest `9.0.2`, Ruff `0.14.14`

The live registry also reported current unconstrained `next=16.4.3`; Next 15 was retained because BRIEF requires Next.js 15.

## Verified output

- `npm install`: exit 0; added 231 packages and audited 234.
- `npm run typecheck`: exit 0 for `@pokescan/web` and `@pokescan/schemas`.
- `npm run lint`: exit 0.
- `npm run test`: exit 0. Vitest: 1 file / 1 test passed. Pytest: `tests/test_health.py` passed (1 passed).
- `npm run dev`, then `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3200/`: `200`. The server was terminated; final port check showed only TIME_WAIT connections, no listener.
- `npm run build`: exit 0. Next 15.5.28 compiled, bundled `/sw.js`, typechecked, and generated static routes.
- `npx playwright install chromium && npm run e2e`: exit 0 after configuring Chromium explicitly; 1 mobile 390×844 smoke test passed.
- Generated icons verified as PNG 192×192 and 512×512.
- `npx --yes --package=node@22 node scripts/verify-better-sqlite3.cjs`: Node `v22.23.4`; `better-sqlite3 loads on Node v22.23.4`.

## Workarounds / current host note

The host default is Node `v24.19.0`, outside the required Node 22 range. A final `bash scripts/setup.sh` check reached `npm ci` but failed because better-sqlite3 13.0.3 has no Node 24 prebuilt and this machine lacks the Visual Studio C++ build tools. This does not affect the required Node 22 path: the isolated Node 22 verification above loaded better-sqlite3 successfully. Use Node 22 (`.nvmrc`) before running setup; do not use the host Node 24 installation.

During scaffolding, Serwist API types required `NetworkFirst`/`StaleWhileRevalidate` strategy instances rather than string handlers. Python test-client additionally requires `httpx`, included as a pinned recognition dev dependency.

## Incomplete / open questions

- Feature schema, catalog sync, API routes, UI, and recognition are intentionally not implemented in this Stage A scaffold.
- The final failed Node 24 `npm ci` may have left local `node_modules` incomplete. Run `npm ci` under Node 22 to restore the working dependency tree.
