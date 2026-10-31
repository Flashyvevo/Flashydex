Project root: C:/Projects/flashydex (cd there first). Product name FlashyDex / package `flashydex`.

# Role: sonnet-mobile-e — Claude Sonnet builder, Stage E (app side of GPT Sol's second review)

`sonnet-core-e` (packages/**) and `sonnet-copy-e` (strings in apps/mobile) have FINISHED or are finishing. Read their
reports first: `.agent/reports/sonnet-core-e-report.md`, `.agent/reports/sonnet-copy-e-report.md`. If core-e's report does
not exist yet, poll `test -f .agent/reports/sonnet-core-e-report.md` (foreground `sleep 120` between checks) while you
do N09 and the parts that don't depend on core.

## Read
1. `.agent/stage-e-contract.md` (binding, E1–E4 + "Mobile side").
2. `.agent/reports/sol-review-2.md` — N03, N07, N09 and R13; §1 "npm run e2e" section.
3. `docs/API.md` → `## Director notes — Stage E (2026-10-31)` (written by core-e; follow the REAL exported core types
   if they differ from the contract and say so).
4. `.agent/reports/grok-copy-review.md` `## Naming` row "Price gap" (the one logic item copy-e skipped).

## Your files (ownership)
`apps/mobile/**` (copy-e is done; keep every string it changed — do not revert copy). Not packages/**.

## Do
- N09 (tooling blocker): the owner's dev server on :3200 is HTTPS (`npm run dev:https`, `FLASHYDEX_DEV_HTTPS=1`,
  `@vitejs/plugin-basic-ssl`) and MUST stay up — never stop/kill/restart it. Make `apps/mobile/playwright.config.ts`
  start its OWN plain-http dev server on port 3201 (`vite --host 127.0.0.1 --port 3201 --strictPort`, env WITHOUT
  FLASHYDEX_DEV_HTTPS), `baseURL` and `webServer.url` `http://127.0.0.1:3201`, `reuseExistingServer: false`. Allow an
  override `FLASHYDEX_E2E_BASE_URL` (when set: use it, `ignoreHTTPSErrors: true`, no webServer). Note 127.0.0.1 is a
  secure context so Web Locks work over http there. `--strictPort` ensures no fall-through to another port. Root
  `npm run e2e` must go green with the :3200 HTTPS server still running. Document in `apps/mobile/README` or the root
  README's dev section (one short paragraph).
- N03 UI half (contract E1): read `useStorageStatus().maintenance`; when `kind==='restore'` show a full-screen blocking
  overlay `data-testid="maintenance-overlay"` (role="alertdialog", aria-live) with "Restoring your backup…" / "Don’t close
  FlashyDex. This takes a moment."; every mutation control is unreachable behind it. Mutations that still get a
  `MAINTENANCE` error show the existing errors.ts copy and are NOT auto-retried. `kind==='catalog_activation'`: small
  non-blocking notice (e.g. in storage-status) — optional if the barrier is sub-second.
  e2e (`apps/mobile/e2e/restore-maintenance.spec.ts`): start a restore, assert the overlay appears while it runs and that
  a write attempted from a second code path during restore is refused (use `page.evaluate` against a dev-only test hook
  if one exists or add a minimal DEV-only `window.__flashydexTest` hook guarded by `import.meta.env.DEV`), and the final
  data equals the archive. If restore is too fast to observe, use a DEV-only slow-down hook (e.g. core's fault/progress
  seam) — never in production builds.
- N07 UI half (contract E2): catalog/detail/sets/dashboard queries treat `STALE_READ` as one silent refetch (TanStack
  `retry` predicate on that code, retry=1), then the existing error copy; `MAINTENANCE` same. No raw driver error text is
  ever rendered (errors.ts fallback already hides it — verify).
- Mobile side of anything else in core-e's Director notes (renamed/added fields, e.g. `StorageStatus.maintenance`,
  sync `failed` + `lastError` now possible after a set failure → the sync UI must show failed + Resume, not "done").
- Price gap (Grok Naming): on card details, when the display currency tab is USD and only a EUR (Cardmarket) price exists,
  show "No USD price" plus the euro amount with its date and source, instead of "No price data" (and vice versa for EUR →
  "No EUR price" + the USD amount). Never convert currencies; never show $0.00. Unit or e2e test.
- R13 cheap residue: add `App/PrivacyInfo.xcprivacy` to the Xcode target's Resources build phase in
  `apps/mobile/ios/App/App.xcodeproj/project.pbxproj` (PBXFileReference + PBXBuildFile + group child + Resources phase
  entry, unique 24-hex IDs, mirror how `config.xml`/`capacitor.config.json` are referenced). Do not touch other native
  settings. Web free-space preflight: if `navigator.storage?.estimate` exists, return `quota - usage` from the web
  platform's free-space method; native stays null (Mac item).

## Don't
- NEVER call capture_screenshot or view any image (crashes the session). Browser checks via js() DOM only, with
  `session="mobile-e"`; for the owner's server: `cdp('Security.setIgnoreCertificateErrors', ignore=True)` then
  `new_tab('https://127.0.0.1:3200/')`.
- Never stop/kill/restart the :3200 server; no second long-lived dev server besides the one Playwright manages on 3201.
- No git commit/push. Don't edit packages/** — if core is wrong, describe it precisely in your report.
- Don't revert copy-e's strings.

## Verify (all must pass before reporting; paste the summary lines)
Root: `npm run typecheck && npm run lint && npm test && npm run build && npm run e2e` (the last one unmodified, while the
HTTPS :3200 server is up — confirm with `netstat -ano | grep :3200` before and after).

## Report
`.agent/reports/sonnet-mobile-e-report.md`: N03/N07/N09/price-gap/R13 → files:lines, tests, results; gates output;
anything from core-e that the UI could not use and why.

## Small extra
- Reword the comment at `apps/mobile/src/data/catalog-hooks.ts:48` ("Infinite card list of one set") to "Infinite list of one set's cards" (copy-e grep gate leftover).
