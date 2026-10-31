Project root: C:/Projects/flashydex (cd there first). Product name FlashyDex / package `flashydex`.

# Role: sonnet-copy-e — Claude Sonnet builder, Stage E copy pass (strings only)

A parallel child (`sonnet-core-e`) is editing `packages/**` right now; it may add a `maintenance` field to core's
`StorageStatus` and touch `apps/mobile/src/data/context.ts`. Don't edit `apps/mobile/src/data/**` or `src/platform/**`.

## Read
1. `.agent/reports/grok-copy-review.md` — the whole file. Sections you apply: `## Change these`, `## Errors and empty
   states that are still generic`, `## Naming`.
2. `docs/UX.md` §12 (error copy table) and §15 (onboarding) — you update its copy tables to match what you ship.

## Owner rulings (binding — override Grok where they conflict)
- Apply EVERY row of `## Change these` EXCEPT:
  - Condition chips stay `NM / LP / MP / HP / DMG` on the add sheet (do NOT expand to words). The "Not set" row (replace
    "Not recorded" with "Not set" in add sheet, copy editor, filter) DOES apply.
  - Language chip/badge becomes `JP` everywhere it is shown (LANGUAGE_BADGE, filter chips, add-sheet chips, custom-card
    chip). Data value stays `ja`. Aria labels stay "Japanese".
  - Step 1 of welcome: REMOVE the Skip control entirely so the notice/disclaimer is always shown once. Find which step is
    step 1 in `components/onboarding-shell.tsx` + `routes/_modal/welcome/*` (Skip currently sets disclaimerAcknowledged
    and enters the app). Later steps keep their Skip / "Skip this step" / "Not now". This removal is the ONLY behaviour
    change you may make.
- Apply `## Errors and empty states` rows: add `SERVER_ERROR`, `RATE_LIMITED`, `BAD_PAYLOAD` cases in `lib/errors.ts`
  (verify the codes exist in `packages/core/src` with grep; keep `HTTP_FAILED` → offline copy unchanged; keep the generic
  fallback); "Couldn’t save that choice. Try again." (both places); "Couldn’t load your collection. Your data hasn’t
  changed." and the sets equivalent where a load-error state exists; import row labels Error/Warning → "Can’t import" /
  "Check this"; set-detail all-tab empty → "No cards in this download"; collection no-match body naming the catalog search.
- Apply `## Naming` rows: Total copies / copies wherever a count of owned rows is labelled "cards" (keep "Unique cards");
  catalog-screen manifest-check row and the add-sheet link "Check for updates" → "Check for a newer catalog"; refresh
  button wording "Update prices" for money, "Refresh this set" for one set; "card list" / "card database" in visible UI →
  "catalog"; TCG Pocket: one phrase "Include TCG Pocket (digital) cards" on the settings switch and welcome switch (both
  are include/show switches already). The collection filter is a HIDE toggle: label it "Hide TCG Pocket (digital) cards"
  — do not invert its logic. Sets-list "TCG Pocket sets hidden · Show" may stay.
  The "No USD price + show the euro amount" item in Naming is a logic change — DO NOT do it; the next child does it.
- Variant labels in `lib/format.ts`: `First edition` → `1st edition` (and `First edition holo` → `1st edition holo`),
  `Stamped promo` → `Stamp`, chip `Shdwl` → `SL`.
- "Update" button in the dashboard value block → "Update prices". Set filter label "In" → "Set" (add sheet). Set-detail tab
  "Dupes" → "Duplicates". Settings → Catalog installed line "Catalog {version}" → "Downloaded · v{version}".
  Prices row "My cards: N cards · about N s" → "Prices for the cards you own." (find where the seconds figure is built,
  likely `lib/catalog.ts` or `routes/_tabs/settings/catalog.tsx`; remove the unmeasured estimate from that row).
- No new numbers the app didn't measure (remove "about 14 MB"; do not add any figure).
- `lib/legal.ts`, the DISCLAIMER / DISCLAIMER_SECONDARY constants and every privacy/legal string stay VERBATIM. Do not
  touch them.

## Your files (ownership)
User-visible strings in `apps/mobile/src/routes/**`, `apps/mobile/src/components/**`, `apps/mobile/src/lib/errors.ts`,
`apps/mobile/src/lib/format.ts`, `apps/mobile/src/lib/catalog.ts` (strings only); `docs/UX.md` copy tables;
TEXT assertions in `apps/mobile/e2e/**` and in mobile unit tests that assert on changed strings. Never change test logic,
selectors other than text, `playwright.config.ts`, or any non-string code (except the step-1 Skip removal).

## grep gate (must return NOTHING from apps/mobile/src before you report; run it and paste the output)
```
cd C:/Projects/flashydex && for s in "Search every English" "Everything stays on this device" "about 14 MB" \
 "search every card" "card id like" "See the format guide" "Starts when the current download finishes." \
 "Something in the form" "First edition" "Stamped promo" "Shdwl" "label: 'JA'" "en: 'EN', ja: 'JA'" "Not recorded" \
 "Variant detail" "Describe the print" "check it</p>" "Paid per card" "Discard this card" "Total cards" \
 "One row per card" "Complete — use" "match cards you already" "label: 'Dupes'" "extra</span>" \
 "single set isn" "You own every card" "Show TCG Pocket cards" "label=\"Hide TCG Pocket\"" "no pictures yet." \
 "Catalog {installed" "Check for updates" "Couldn’t save. Try again." "card list"; do \
 grep -rnF "$s" apps/mobile/src | grep -v '\.test\.' ; done; echo GATE-END
```
(If a string legitimately survives in a code comment, rewrite the comment too.) Also grep for the remaining Grok rows
you applied that aren't in this list ("In" filter label, "Update" button, "My cards:", "Import N cards") and show evidence.

## Verify
- `npm run typecheck && npm run lint` (root) and `npm run test --workspace=@flashydex/mobile`.
- e2e: the checked-in Playwright config is broken by the HTTPS dev server (another child fixes it later). Run the suite
  with a scratch config instead, without editing the checked-in one: create
  `C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/copy-e-playwright.config.ts` that imports the real config from
  `C:/Projects/flashydex/apps/mobile/playwright.config.ts`, spreads it, sets `testDir` to the absolute e2e dir,
  `use.baseURL: 'https://127.0.0.1:3200'`, `use.ignoreHTTPSErrors: true`, `webServer: undefined`; run
  `npm run e2e --workspace=@flashydex/mobile -- --config <that path>`. The HTTPS dev server on :3200 belongs to the owner:
  NEVER stop, restart or kill it and never start another server. If a failure is clearly caused by core-e's in-flight
  work (not text), note it and move on.
- Optional DOM check in the browser with `session="copy-e"`: `cdp('Security.setIgnoreCertificateErrors', ignore=True)`
  then `new_tab('https://127.0.0.1:3200/')` at 390×844. NEVER call capture_screenshot or view any image — it crashes the
  session.
- No git commit/push.

## Report
`.agent/reports/sonnet-copy-e-report.md`: table `Grok row → applied (file:line) | skipped (why)` covering every row of the
three sections, the grep-gate output, gates output, e2e result (N passed / failures with cause), UX.md sections changed.
