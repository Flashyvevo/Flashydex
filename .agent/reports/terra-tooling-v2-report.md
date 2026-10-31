# Terra tooling v2 report

## Produced

- Replaced the root workspace scripts with the FlashyDex Vite/mobile/core layout.
- Added `apps/mobile` Vite + React 19 + TypeScript + Tailwind v4 + TanStack Router/Query scaffold, Capacitor 7 config, PWA manifest/icon generator, platform class helper, SQLite driver/proxy scaffold, component test, and Playwright smoke test.
- Added `packages/core` skeleton with empty schema placeholder, migration/platform placeholders, Drizzle config, and a passing real `better-sqlite3` + `drizzle-orm/sqlite-proxy` Vitest test.
- Added web SQL.js WASM copy script, iOS Mac handoff notes, CI Vite workflow, revised README/notices, and renamed owned recognition title to FlashyDex.

## Pinned versions

- React/react-dom 19.3.1; TypeScript 5.9.3; Vite 7.3.7; Tailwind/@tailwindcss-vite 4.3.3.
- TanStack Router 1.170.46 / plugin 1.168.48; TanStack Query 5.105.0.
- Capacitor core/CLI/iOS/Android 7.6.10; community SQLite 7.0.3; app 7.1.2; filesystem 7.1.9; share 7.0.4; haptics 7.0.5; status-bar 7.0.6; splash-screen 7.0.5.
- Drizzle ORM 0.45.4; drizzle-kit 0.31.11; better-sqlite3 13.0.3; jeep-sqlite 2.8.0; Vitest 5.0.5; Playwright 1.64.1.

## Verified output

- `npm install`: exit 0; 711 packages installed. The postinstall copied `sql-wasm.wasm` and generated the abstract 192/512 PNG icons. npm reported 28 audit findings.
- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0.
- `npm test`: exit 0: core Vitest 1/1, mobile Vitest 1/1, pytest 1/1.
- `npm run dev`, then `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3200/`: `200`.
- `npm run build`: exit 0; Vite built 290 modules and generated PWA assets/service worker.

## Incomplete / blockers

- `npm run e2e` is not green. Chromium installed, the heading renders, but web SQLite remains at `Opening local SQLite…`; `jeep-sqlite` custom-element readiness never resolves. The WASM was corrected to the documented `public/assets/sql-wasm.wasm` path, but the driver still needs focused debugging before the SQLite version assertion can pass.
- `npx cap add ios`, `npx cap add android`, and final `npx cap sync` were not run before this time-limited handoff. Native projects are therefore not yet generated.
- The development server process manager reported the Vite parent killed, but a native child remained listening on port 3200. A forceful native task kill was blocked by the unattended-session safety gate; director should terminate PID 22952 before starting another server.
- The Capacitor SQLite plugin uses SQLCipher, so the README’s previous “no custom encryption” assumption needs App Store export-compliance review before submission.

## Mac handoff

Run `npm run build`, `npm run cap:sync`, then `npx cap open ios` on the Mac. Set the signing team and bundle identifier in Xcode; run `pod install` from `apps/mobile/ios/App` only if CocoaPods requires it.
