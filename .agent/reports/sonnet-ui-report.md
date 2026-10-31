# sonnet-ui report — INCOMPLETE (run budget exhausted)

## Verified
- `tsc --noEmit -p tsconfig.app.json`: clean (no output) after the last edits.
- `eslint src`: 9 errors, 23 warnings. NOT clean. The errors are react-hooks v7 `set-state-in-effect` in `lib/hooks.ts`, `components/sync.tsx` and `welcome/languages.tsx`, plus a few more I did not read. Warnings are mostly react-refresh export warnings.
- Browser (session `ui`, 390x844):
  - App boots to `/welcome`.
  - Welcome → notice (exact disclaimer shown) → languages (manifest sizes shown: EN 128 KB, JA 117 KB) → sets → "Start download" lands on `/` with the ProgressCard "Downloading the English card catalog".
  - `/settings/catalog` renders.

## NOT done / NOT verified
- The dev-pack install did not finish. After Start download the Dashboard fell back to "Download the card catalog". `/settings/catalog` then showed English with "Retry / The catalog couldn't be installed".
  - Possible causes: a Vite HMR page reload from the other builder's edits interrupted the install, or a real data-layer install failure.
  - Cause not diagnosed; I did not check `install.error.code`.
- Not run: `npm test`, `npm run e2e`, DOM-check table for every route, console-error check.
- Not written:
  - `apps/mobile/e2e/*` specs. `sqlite.smoke.spec.ts` is still the old root-page version and will fail, because `/` is now the Dashboard.
  - `playwright.config.ts` two-viewport projects.
  - Component tests. I deleted the old `app.test.tsx` and wrote none.
  - Sonnet-ui-requests file.
- Not walked in a browser at all: `/`, `/collection`, `/cards/*`, `/sets*`, `/add`, `/custom-cards/new`, `/settings/*`.
- No acceptance IDs can be claimed as evidenced.

## Built (files under apps/mobile)
- Config: `index.html` (viewport-fit=cover, theme-color #0b0d12), `capacitor.config.ts` (contentInset never, adjustMarginsForEdgeToEdge force, backgroundColor, SplashScreen launchAutoHide false), `src/styles/globals.css` (Tailwind mapping + tokens import + Inter), `main.tsx`.
- Deps added (`apps/mobile/package.json`): lucide-react, @fontsource-variable/inter, zod, @capacitor/network, @capacitor/browser.
- Lib: `format, prefs, native, errors, hooks, catalog (D12 stage map), legal (disclaimer, privacy text, licenses), sheets, collection-query`.
- Components:
  - `ui` (primitives)
  - `overlay` (BottomSheet with discard guard, Dialog, toasts)
  - `card` (CardArt with placeholders, tile, row, badges)
  - `owned`, `page`, `shell` (tab bar, disabled Scan, sidebar), `sync` (pill, ProgressCard)
  - `filters`, `set-picker`, `set-logo`, `onboarding-shell`
  - `add-confirm`, `copy-editor`, `card-details`, `custom-card-view`
- Routes: `__root` (startup gate), `_tabs`, `_modal`, Dashboard, Collection, `/cards/$language/$cardId`, `/collection/$ownedId`, `/custom-cards/$customId`, Sets, Set detail, `/add`, `/custom-cards/new`, `/welcome/*` (4 steps), `/settings` (home, catalog, data, about, privacy, licenses, locations).

## Findings
- **Dev server.** The brief said one was running on 3200, but nothing was listening. I started `npm run dev` from `apps/mobile` (pid 23752, background proc `proc_f232f175b1a9`). The owner must stop it.
- **Hidden tab.** In the shared browser the tab is `hidden`, so `requestAnimationFrame` is paused. jeep-sqlite never hydrates and the app sits on "Opening your collection…". `cdp('Page.bringToFront')` fixes it. Playwright is unaffected.
- **Gap in `BackupService` typing.** `useCreateBackup`, `usePreviewRestore` and `useRestore` results are typed `never`. I cast them in `data.tsx`. Backup and restore behaviour is unverified.
- **Missing fields (UI degrades gracefully):**
  - `officialCount` on OwnedDto and CardSummary. Cards show `#136`, not `136/189`.
  - Newest price date on DashboardDto. The "prices as of" line is omitted.
  - Release year on CardSummary. Search rows omit it.
  - A filter or hook for copies of a custom card. The custom card view lists by name and language, then filters by `customCardId`.
- **Non-atomic acquisition writes.** The copy editor creates or updates the shared acquisition through `useServices().collection` and then patches the copy. The hook surface has no wrapper for that.

## Open questions
- Privacy policy contact email and hosted URL are not set. The in-app text drops the owner brackets, and "View online" is hidden when `FLASHYDEX_PRIVACY_URL` is empty.
- Pocket filter: I added "Hide TCG Pocket" to the Collection filter sheet per D5, though UX §4.4 says it is not a filter there.
