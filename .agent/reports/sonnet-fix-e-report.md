# sonnet-fix-e report (Stage E strings)

## Changes (apps/mobile/src, labels only)
F1 language code -> LANGUAGE_BADGE[...] (import added from lib/format):
- routes/_modal/add.tsx:169 (set picker options), components/filters.tsx:20, routes/_tabs/sets/$language/$setId.tsx:119 (unused LANGUAGE_NAMES import removed),
  components/sync.tsx:238, components/add-confirm.tsx:268, components/set-picker.tsx:59,
  routes/_tabs/collection/index.tsx:226 (active-filter chip), routes/_tabs/settings/index.tsx:102,
  routes/dev/pack-test.tsx:113,120 (dev page, also swapped so no toUpperCase remains).
F2 "Condition not recorded" -> "Condition not set": components/card-details.tsx:26, routes/_tabs/collection/index.tsx:227, components/card.tsx:58 (comment).
F3 routes/_tabs/collection/index.tsx:116: plural(totalCards,'copy','copies') -> "3 copies · 2 unique", "1 copy". Confirmed totalCards is total copies (home screen StatTile "Total copies" uses d.totalCards). "Show N cards" untouched.
F4 routes/_modal/add.tsx:148 placeholder "Search name or number"; e2e/helpers.ts:32 selector updated.
docs/UX.md copy lines: 187, 193, 929 (JA -> JP), 494 ("412 copies · 301 unique").

## Gate
toUpperCase part: prints nothing (clean; no surviving hits, including sql/keyword-excluded ones were not language uses).
Second grep: pattern `'JA'` with -i also matches the lowercase data value 'ja' (type unions, lang="ja" attrs, zod enums,
bootstrap set-index-ja.json "language": "ja", etc.), so the gate as written cannot print only GATE-END.
Those are all data values / BCP-47 lang attributes the owner said stay `ja`. No "not recorded", "number or id", or on-screen 'JA'/"JA" strings remain
(verified with a case-sensitive check: zero hits). Output ends with GATE-END.

## Verify
- typecheck: pass (after removing the now-unused LANGUAGE_NAMES import)
- lint: pass
- mobile unit tests: 8 files / 30 tests pass
- e2e: first run 19 passed, 2 failed (mobile catalog-failure, core-flow: 'English catalog ready' 60s timeout under parallel load);
  both re-run (mobile + desktop, 6 tests) pass. Not string-related.
No git commit; :3200 server untouched.
