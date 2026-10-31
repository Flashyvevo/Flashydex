Project root: C:/Projects/flashydex (cd there first). Product name FlashyDex.

# Role: sonnet-fix-e — Claude Sonnet, Stage E fix round (strings only, apps/mobile)

The director's DOM walk at 390 over the owner's HTTPS server found copy-pass leftovers. Owner ruling: the language
chip/badge is `JP` on screen everywhere (data value stays `ja`; aria/long names stay "Japanese"); "Not set" replaces
"Not recorded"; owned-row counts are "copies".

## Defects (verbatim from the walk)
F1. "JA" still rendered via `language.toUpperCase()` / `LANGUAGE_NAMES[...].slice(0,2).toUpperCase()`:
  - add sheet set picker options "ポケモンカード151 (JA)" — `routes/_modal/add.tsx:169`
  - collection filter sheet set options — `components/filters.tsx:20`
  - set detail header "SV · Jun 16, 2023 · JA" — `routes/_tabs/sets/$language/$setId.tsx:119`
  - Settings row "EN ✓ · JA ✓" — `components/sync.tsx:238` (LangStatus `code`)
  - also `components/add-confirm.tsx:268`, `components/set-picker.tsx:59`, `routes/_tabs/collection/index.tsx:226`
    (active-filter chip), `routes/_tabs/settings/index.tsx:102`.
  Fix: use `LANGUAGE_BADGE[language]` from `lib/format.ts` (already `{en:'EN', ja:'JP'}`) for every on-screen language
  code. Grep every `toUpperCase` in apps/mobile/src and fix any other language display.
F2. Card details copy row "Holo · Condition not recorded" — `components/card-details.tsx:26`; collection active-filter
  chip "Condition not recorded" — `routes/_tabs/collection/index.tsx:227`; comment in `components/card.tsx:58`.
  → "Condition not set".
F3. Collection header "3 cards · 2 unique" counts copies → "3 copies · 2 unique" (singular "1 copy"). Find it in
  `routes/_tabs/collection/index.tsx`; confirm the first number is total copies, not groups, before changing.
  "Show N cards" in the filter sheet counts tiles — leave it.
F4. Add-sheet search placeholder "Search name, number or id" (`routes/_modal/add.tsx:148`) → "Search name or number".

## Files
Strings only in `apps/mobile/src/**` (no logic changes beyond swapping the label source in F1), `docs/UX.md` copy
lines if they show these strings, and text assertions in `apps/mobile/e2e/**` / mobile unit tests that assert on them.

## Gate (paste output; must print only GATE-END)
```
cd C:/Projects/flashydex && grep -rn "toUpperCase" apps/mobile/src | grep -iv "sql\|keyword\|\.test\." ; \
grep -rni "not recorded\|number or id\|'JA'\|\"JA\"" apps/mobile/src | grep -v "\.test\." ; echo GATE-END
```
(Any surviving `toUpperCase` hit must be a non-language use — say which and why.)

## Verify
`npm run typecheck && npm run lint && npm run test --workspace=@flashydex/mobile && npm run e2e` (root; e2e starts its own
http server on :3201). The owner's HTTPS dev server on :3200 must never be stopped/restarted/killed. Never call
capture_screenshot or view images (crashes the session); browser optional with `session="fix-e"`. No git commit.

## Report
`.agent/reports/sonnet-fix-e-report.md`: each F → file:line changed, gate output, gate results.
