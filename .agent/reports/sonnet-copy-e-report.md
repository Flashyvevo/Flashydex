# sonnet-copy-e report — Stage E copy pass

Paths are under apps/mobile/src unless noted. Line numbers: `grep -n` the new string. All edits are strings except the step-1 Skip removal.

## Grok `## Change these`
| Row | Result |
|---|---|
| welcome bullet "Search every…" | applied — routes/_modal/welcome/index.tsx |
| welcome bullet "Everything stays…" | applied — same file |
| Skip on step 1 | applied (owner ruling): control removed, a spacer keeps the header layout; dead `step === 1` branch in `skip()` removed — components/onboarding-shell.tsx. Steps 2–4 keep Skip. |
| dashboard empty "14 MB" | applied — routes/_tabs/index.tsx |
| add.tsx empty catalog body | applied — routes/_modal/add.tsx |
| add.tsx empty query | applied — routes/_modal/add.tsx |
| add set filter "In" → "Set" | applied — routes/_modal/add.tsx |
| value block "Update" → "Update prices" | applied — routes/_tabs/index.tsx |
| catalog prices row "My cards: N…" | applied → "Prices for the cards you own." The seconds estimate is gone — routes/_tabs/settings/catalog.tsx |
| SERVER_ERROR / RATE_LIMITED / BAD_PAYLOAD | applied — lib/errors.ts. Codes confirmed in packages/core/src/services/sync.ts:695,710,712. HTTP_FAILED copy and the generic fallback are unchanged. Titles are mine: "TCGdex isn’t responding", "TCGdex asked us to slow down", "Couldn’t read the download". Bodies follow Grok, with the SERVER_ERROR body shortened to "The catalog source is having trouble…" (no "card list"). |
| INSTANCE_LOCK | applied — lib/errors.ts |
| IMPORT_INVALID body | applied — lib/errors.ts |
| ACTIVE_SYNC body | applied — lib/errors.ts |
| VALIDATION_ERROR body | applied — lib/errors.ts |
| variant labels 1st edition / Stamp (+ "1st edition holo") | applied — lib/format.ts |
| chip Shdwl → SL | applied — lib/format.ts |
| language badge JA → JP | applied (owner ruling) in LANGUAGE_BADGE, add-sheet chips, filters, custom-card chip (view + new), sets-list chips, settings search-language chips. Data stays `ja`, aria stays "Japanese". |
| condition chips as words | SKIPPED — owner ruling, chips stay NM/LP/MP/HP/DMG |
| "Not set" for Not recorded | applied — copy-editor.tsx, filters.tsx. add-confirm.tsx already said "Not set". `CONDITION_LABEL.unknown` is now "Condition not set". |
| Variant detail / Describe the print | applied — "What print is this? (required)", error "Say what print this is", placeholder "Stamp, cosmos holo, misprint" (add-confirm.tsx, copy-editor.tsx). The error wording is mine; Grok only gave the label and the placeholder. |
| "check it" | applied — add-confirm.tsx |
| Paid per card → copy | applied — add-confirm.tsx |
| Discard this card? → copy | applied — add-confirm.tsx |
| Total cards / known cost on N cards | applied — "Total copies", "N copies with a known cost" — routes/_tabs/index.tsx |
| CSV row | applied — settings/data.tsx |
| JSON row | applied — settings/data.tsx |
| Import N cards → copies | applied — settings/data.tsx |
| "match cards you already have" | applied — settings/data.tsx |
| Dupes → Duplicates | applied — sets/$language/$setId.tsx |
| "N extra" → "N extra copies" | applied — sets/index.tsx |
| single-set banner | applied — sets/$language/$setId.tsx |
| missing-tab "You own every card" | applied — incomplete set: "Nothing missing in the cards downloaded for this set."; complete set: "Nothing missing from {name}." |
| TCG Pocket phrase | applied — settings switch "Include TCG Pocket (digital) cards"; the welcome switch already said it; the collection filter is the hide toggle "Hide TCG Pocket (digital) cards" with logic untouched. The sets-list "hidden · Show" line is unchanged. |
| Japanese pictures line (welcome) | applied — "…no pictures in the catalog yet." |
| catalog "Catalog {version}" | applied → "Downloaded · v{version}" |

## `## Errors and empty states`
| Row | Result |
|---|---|
| SERVER_ERROR / RATE_LIMITED / BAD_PAYLOAD | applied (see above) |
| "Couldn’t save." (welcome) | applied — now "Couldn’t save that choice. Try again." in onboarding-shell, notice, languages, sets (four places; the last two previously said "your choice") |
| load-error copy for dashboard | kept as is |
| collection load error | applied — ErrorState title "Couldn’t load your collection", body "Your data hasn’t changed." |
| sets load error | applied — "Couldn’t load your sets" / "Your data hasn’t changed." (sets list only; set-detail load errors keep the generic ErrorState) |
| import row labels | applied → "Can’t import" / "Check this" — settings/data.tsx |
| set-detail all-tab empty | applied → "No cards in this download" |
| collection no-match body | applied — appends " Search the catalog for it." when there is a query, keeping the quoted query |
| "Not available yet" / "Price updates aren’t available yet" | kept |
| Loading… | kept |

## `## Naming`
| Row | Result |
|---|---|
| catalog vs "card list" / "card database" | applied in UI; "card list" is gone from visible UI and docs/UX.md §12 no longer says "card database" |
| copies vs cards for owned counts | applied: Total copies, gain line, import button, location-delete confirm (`plural(copyCount,'copy','copies')`), "N extra copies". Left alone: "Unique cards"; collection "N matching cards" (counts grouped tiles); catalog-download "cards"; IN_USE "used by N cards" (dependents' unit isn't certain) |
| "Check for updates" → "Check for a newer catalog" | applied on the catalog screen and add sheet |
| "Update prices" / "Refresh this set" | applied; the catalog button and refresh-set row already used these words |
| Collecting vs following | no change needed |
| Print labels | applied (lib/format.ts) |
| Language chip | applied (JP) |
| Condition words on forms | skipped (owner ruling) |
| "No USD price, show euro" | NOT DONE, per instructions (logic change; next child) |
| Raw/Graded, Location | no change needed |

## grep gate
```
apps/mobile/src/data/catalog-hooks.ts:48:/** Infinite card list of one set. `ownership: 'all'|'owned'|'missing'`, `duplicates: true` for the duplicates tab. */
GATE-END
```
The one hit is a code comment in `data/**`, which is outside my ownership and not shown to users. The next owner of `data/**` can reword it ("Infinite list of one set's cards"). No user-visible string matches.

Extra evidence: grep for `'JA'`, `label="In"`, `>Update<`, `My cards:`, `Import {plural(toAdd, 'card'`, `Couldn’t save your choice`, `card database` and `about ${Math` over apps/mobile/src (excluding legal.ts) returned nothing.

## Gates
- `npm run typecheck && npm run lint`: pass, 0 errors, 21 existing react-refresh warnings.
- `npm run test --workspace=@flashydex/mobile`: 6 files, 22 tests passed.
- e2e (scratch config at C:/Users/AshtonSeabolt/AppData/Local/hermes/cache/scratch/copy-e-playwright.config.ts, HTTPS :3200 with ignoreHTTPSErrors, server untouched): **20 passed, 0 failed** (mobile + desktop). No e2e or unit-test text assertions needed changing (the only text assertion, "Update" in catalog-failure.spec.ts, still matches "Update · size").
- No DOM check in the browser; no screenshots taken.

## docs/UX.md sections changed
§3 (EN/JP badge), §4 accessibility note and dashboard sketch (Total copies, empty-state body, Update prices), §5 filter chips, §6 TCG Pocket wording, §7 search/add sketch (Set:, Paid per copy, Discard this copy, "Check for a newer catalog"), §8–9 sets and settings sketches (JP, Include TCG Pocket (digital) cards, prices row, manifest row), §12 copy table (SERVER_ERROR/RATE_LIMITED/BAD_PAYLOAD, IMPORT_INVALID, button vocabulary "Import N copies"), §14 discard step, §15.2 and §15.3 (no Skip on step 1, new welcome bullets), §15.5 and §15.6 chips (JP, catalog-pictures caption). The §15.5 sketch still shows manifest-derived figures ("14 MB download"). These are mock numbers from the manifest, not literals in the app.

## Notes
- The JSON export row says "Notes and prices you entered are included". I took that from Grok's table and didn't verify it against core.
- Nothing under data/**, platform/**, or packages/** was touched. No git commit.
