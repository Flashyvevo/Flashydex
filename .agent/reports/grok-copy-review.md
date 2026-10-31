# Grok — words review, FlashyDex Phase 1

Role: UX copy and positioning only. No app files edited. No commit.

Reviewed 2026-10-31 from `apps/mobile/src/**/*.ts(x)` (string inventory of routes, components, `lib/errors.ts`, `lib/format.ts`, `lib/legal.ts`) against `docs/UX.md` §12 and §15, `BRIEF.md` price/disclaimer rules, and `docs/APP-STORE-COMPLIANCE.md`.

Live walk: `https://127.0.0.1:3200` at 390×844, session `grok`, certificate errors ignored. HTTP on :3200 returns an empty reply; HTTPS answers 200. The page title is FlashyDex. The only user-facing string that rendered was “Opening your collection…”. `jeep-sqlite.entry.js` never finished loading (resource duration 0), so welcome, add, collection, card, sets, and settings were not walked. Those strings below are from the source that ships, not from a painted screen.

## Voice

It is one voice, and it is not corporate. Short sentences, contractions, no “Oops”, no “Submit”, no “unlock your potential”. The good lines sound like a person who has held a card: “Add slabs with certificate numbers one at a time”, “Sets I collect”, “Raw / graded”, “Your cards stay in your collection”.

It is not collector-native all the way through. The same screens drop into database talk: “card id like swsh3-136”, “Variant detail (required)”, “Shdwl”, “JA”, “about 14 MB”, “or open FlashyDex over https or on localhost”. A collector would not say those. A careful engineer would.

Keep the plain voice. Cut the schema names and the numbers the app did not measure. Do not add warmth, jokes, or a mascot.

Leave these alone. They are already the right words:

- The disclaimer sentence, exact, on About and at the bottom of Settings.
- “No price data” / “No price data from TCGdex for this card.” Never “$0”.
- “N of M copies priced” on the dashboard.
- “Graded copies aren’t valued automatically. Set your own price in the copy.”
- “The download was damaged and wasn’t installed. Your current catalog is unchanged.”
- “Your cards stay in your collection — you’ll see what you saved, without prices and card info, until you download it again.”
- “Camera scanning is coming” / “Scanning arrives in a later update.” No fake date.
- “Many older Japanese cards have no pictures yet.” Honest. Use the longer catalog version everywhere (below).
- Scan tab label “Soon”. Do not promise a version.

## Change these

location | current | proposed | why
---|---|---|---
`routes/_modal/welcome/index.tsx` bullet | Search every English and Japanese card | Search English and Japanese cards once they’re downloaded | “Every” is false. Empty set shells are hidden. The pack can lag TCGdex. Some cards have no picture.
`routes/_modal/welcome/index.tsx` bullet | Everything stays on this device — no account, works offline | Your collection stays on this device. No account. Search works offline after the download. | Offline search needs the catalog. Pictures can still be missing. The collection itself does stay on the device.
`components/onboarding-shell.tsx` Skip, step 1 | Skip | Remove Skip on step 1, or make it open the notice | Skip sets `disclaimerAcknowledged: true` and enters the app. The notice is never shown. UX.md says the disclaimer is shown at least once. “Skip” does not say that. Steps 2–4 can keep Skip; the notice is already behind them.
`routes/_tabs/index.tsx` empty catalog | It downloads once (about 14 MB for English) and then works offline. | It downloads once, then search works offline. | 14 MB is typed in. The languages screen already uses the manifest size. Do not invent a second number.
`routes/_modal/add.tsx` empty | Download it once to search every card. | Download it once to search the cards in that catalog. You can still add a custom card. | Same “every” problem.
`routes/_modal/add.tsx` empty query | Type a card name, a collector number like 136/189, or a card id like swsh3-136. | Type a name, or a number like 136/189. | `swsh3-136` is a database id. A collector has a name or a number.
`routes/_modal/add.tsx` set filter label | In | Set | “In” does not say what the control is.
`routes/_tabs/index.tsx` value block button | Update | Update prices | The visible word is “Update” next to “TCGplayer prices”. UX.md already asked for “Update prices”. Catalog update is a different action.
`routes/_tabs/settings/catalog.tsx` prices | My cards: N cards · about N s | Prices for the cards you own. | The seconds figure is `owned / 25` with no measured rate. Also says “cards” for a count of copies.
`lib/errors.ts` `SERVER_ERROR` (no case today) | Something went wrong. Try again. | TCGdex isn’t responding. The card list is having trouble. Your collection is fine — try again later. | A 5xx is stored as `SERVER_ERROR` (`packages/core/src/services/sync.ts`). It is not `HTTP_FAILED`. `HTTP_FAILED` is the timeout/offline path, and “You’re offline” is fair for that code. Do not relabel it.
`lib/errors.ts` `RATE_LIMITED` (no case) | Something went wrong. Try again. | TCGdex asked us to slow down. Try again in a few minutes. Your collection is fine. | Same fetch path. Don’t say “offline”.
`lib/errors.ts` `INSTANCE_LOCK` | Only one FlashyDex tab can edit at a time. Close the other tab and reload, or open FlashyDex over https or on localhost. | Close the other tab, then reload this one. | The lock screen already says the second sentence. The https/localhost line is for the person building the app.
`lib/errors.ts` `IMPORT_INVALID` body | See the format guide. | It isn’t a FlashyDex JSON export or a CSV with the expected columns. | There is no format guide in the app.
`lib/errors.ts` `ACTIVE_SYNC` body | Starts when the current download finishes. | A download is already running. This starts when that one finishes. | The current line is a fragment.
`lib/errors.ts` `VALIDATION_ERROR` body | Something in the form isn’t valid. | Fix the fields marked above. | The title already says “Check the highlighted fields.” The body should say what to do.
`lib/format.ts` variant labels | First edition / Stamped promo | 1st edition / Stamp | TCGplayer’s printing name is “1st Edition”. Collectors say “1st edition” and “stamp”, not “First edition” or “Stamped promo”.
`lib/format.ts` `VARIANT_CHIP.shadowless` | Shdwl | SL | Nobody writes “Shdwl”. The long label on the chip’s name can stay “Shadowless”.
`lib/format.ts` language badge | JA | JP | Collectors say JP. JA is the database code. Keep `ja` in data. Say Japanese in full, JP on the chip.
`components/add-confirm.tsx` condition chips | NM, LP, MP, HP, DMG | Near Mint, Lightly Played, Moderately Played, Heavily Played, Damaged | There is room on the sheet. TCGplayer’s abbreviation for Damaged is DM, not DMG. Words avoid the fight. Keep the abbreviations on tiles.
`components/add-confirm.tsx` vs `copy-editor.tsx` / filters | Not set / Not recorded | Not set | “Not recorded” sounds like the app lost the condition. The user left it unset. Use “Not set” in the add sheet, the editor, and the filter.
`components/add-confirm.tsx` | Variant detail (required) / Describe the print | What print is this? / Stamp, cosmos holo, misprint | “Variant detail” is a column name.
`components/add-confirm.tsx` | Variant not listed in the catalog — check it | This print isn’t listed. Pick the closest one. | “Check it” sounds like the user did something wrong.
`components/add-confirm.tsx` | Paid per card | Paid per copy | The button next to it already says “Add 3 copies”.
`components/add-confirm.tsx` discard | Discard this card? | Discard this copy? | Nothing was saved. “Card” sounds like the catalog card is being thrown away.
`routes/_tabs/index.tsx` tiles | Total cards / known cost on N of M cards | Total copies / known cost on N of M copies | The line under the value already says “copies priced” for the same number.
`routes/_tabs/settings/data.tsx` CSV row | One row per card, for spreadsheets. Some details aren’t included. | One row per copy, for spreadsheets. Price history isn’t included. | `docs/IMPORT-EXPORT.md`: CSV is one physical copy per row.
`routes/_tabs/settings/data.tsx` JSON row | Complete — use this to move to another device or app. | Use this to move your collection to another device. Notes and prices you entered are included. | “Complete” reads as a status, not a description.
`routes/_tabs/settings/data.tsx` import button | Import N cards | Import N copies | The policy chip on the same sheet already says “copy”.
`routes/_tabs/settings/data.tsx` preview | match cards you already have | match copies you already have | Same sheet, same mix-up.
`routes/_tabs/sets/$language/$setId.tsx` tab | Dupes | Duplicates | Every other screen says Duplicates. One slang chip is not a voice.
`routes/_tabs/sets/index.tsx` row | N extra | N extra copies | “Extra” doesn’t say extra what.
`routes/_tabs/sets/$language/$setId.tsx` banner | Downloading a single set isn’t available yet. | You can’t download just this set yet. | Same fact. Less like a status code.
`routes/_tabs/sets/$language/$setId.tsx` missing-tab empty, when the set is incomplete | You own every card in {name}. | Nothing missing in the cards downloaded for this set. | “Every card” is false while the banner says the set isn’t fully downloaded.
`routes/_tabs/settings/index.tsx` vs welcome vs filters | Show TCG Pocket cards / Include TCG Pocket (digital) cards / Hide TCG Pocket | Include TCG Pocket cards | One phrase. “(digital)” is useful; put it on the settings row too, or drop it everywhere.
`routes/_modal/welcome/languages.tsx` vs catalog | Many older Japanese cards have no pictures yet. | Many older Japanese cards have no pictures in the catalog yet. | The catalog screen already has the precise line. The pictures may exist; this download doesn’t have them.
`routes/_tabs/settings/catalog.tsx` installed line | Catalog {version} | Downloaded · v{version} | “Catalog 3” sounds like a product name.

## Errors and empty states that are still generic

These have no specific sentence today. Fallback is “Something went wrong. Try again.” with the code under Details. Keep that fallback. Add these cases so the fallback is rare:

code or screen | proposed
---|---
`SERVER_ERROR` | TCGdex isn’t responding. The card list is having trouble. Your collection is fine — try again later.
`RATE_LIMITED` | TCGdex asked us to slow down. Try again in a few minutes. Your collection is fine.
`BAD_PAYLOAD` | TCGdex sent something FlashyDex couldn’t read. Your collection is fine. Try again later.
`Couldn’t save. Try again.` (welcome) | Couldn’t save that choice. Try again.
`Couldn’t load your dashboard` | Keep. This one already says what failed and that the data didn’t change. Copy that shape for collection and sets: “Couldn’t load your collection. Your data hasn’t changed.”
Import row labels `Error` / `Warning` | Can’t import / Check this
Set detail, all-tab empty | No cards in this download
Collection, no query match | Nothing in your collection matches “{q}”. | Keep the quoted query. Add: Search the catalog for it. The link is already there; the body should name it.
`Not available yet` / `Price updates aren’t available yet` | Keep, if the button really cannot run. Do not soften it into “Coming soon”.
`Loading…` / `Loading card` | Fine. Do not replace with a joke.

Do not add “Oops”. Do not blame the user. Do not auto-retry an add.

## Naming

Pick one word per idea and use it in the visible UI. Code names can stay.

Idea | Use this | Stop using | Where it drifts
---|---|---|---
The downloaded card list | Catalog | card database, card list, pack | Dashboard empty says “card list”. UX.md’s error table says “card database”. User-facing “pack” does not appear, which is right. Keep it that way. “Packing your data…” on restore is the verb, and it’s fine.
An owned physical card | Copy | card, when the number is a count of owned rows | Add sheet is consistent (“Add 3 copies”). Dashboard, import, and the paid tile say “cards” for the same count. “Total cards” should be “Total copies”. “Unique cards” can stay.
The thing in the catalog | Card | copy | “Add a card” as the entry point is right. “Discard this card?” is not, because no catalog card is being discarded.
Getting a new catalog | Download | Sync, pack | Good today. Keep Download.
Replacing a catalog | Update | Sync | “Update · 12 MB” is clear. “Check for updates” on the same screen is the manifest check. That’s a second meaning of update. Rename the manifest row to “Check for a newer catalog”.
Refreshing prices | Update prices | Update, Sync, Refresh | Dashboard button says Update. Card/set say Refresh. Pick “Update prices” for money and “Refresh this set” for one set. Don’t add Sync.
Refreshing one set from TCGdex | Refresh this set | Sync this set | Already good.
Choosing sets to keep fresh | Collecting | Following | UI says “Sets I collect” / “Collecting this set”. The code says `setsFollowed`. Don’t let “following” leak into a label.
A print | 1st edition, Holo, Reverse holo, Shadowless, Stamp | First edition, Stamped promo, Rev, Shdwl | “Holo” and “Reverse holo” are the collector words. TCGplayer’s marketplace strings are Holofoil and Reverse Holofoil. Don’t rename the UI to the marketplace string. The price caption already says TCGplayer.
Language chip | EN, JP | JA | See table.
Condition | The words on forms, the abbreviations on tiles | DMG as if it were TCGplayer’s code | TCGplayer’s API abbreviation for Damaged is DM (`docs.tcgplayer.com` catalog conditions, fetched 2026-10-31). Pokémon collectors write DMG. Showing “Damaged” on the form ends the argument.
Raw vs slab | Raw / Graded | ungraded | “Raw / graded” is the right pair. Keep it.
Price gap | No price | No price data, on a tile | Tiles should keep hiding a null price (they do). Details can say “No price data”. When the display currency is USD and the only number is EUR, say “No USD price” and show the euro amount. BRIEF requires that. The details screen says “No price data” for an empty currency tab, which hides a euro price the user could still see. That is the one price sentence to fix.
Storage | Location | binder, as the field name | “Binder” in the empty state (“each binder, box or deck”) is good. The field stays Location.

## TCG terminology

Checked against TCGplayer’s condition guide and condition API (Near Mint NM, Lightly Played LP, Moderately Played MP, Heavily Played HP, Damaged DM), TCGplayer’s rarity article (“Reverse Holo”), and how Collectr / TCG Collector are described in their listings and on the TCG Collector set pages (card numbers as `1/123`, rarity “Rare Holo”). Collectr’s in-app variant picker was not opened; community descriptions of it say “normal” and “reverse holo”.

Term | FlashyDex | Verdict
---|---|---
Near Mint / LP / MP / HP / Damaged | Full names exist in `CONDITION_LABEL`. Chips show NM LP MP HP DMG. | Names match TCGplayer and collector speech. Chip “DMG” does not match TCGplayer’s DM. Use the words on the form.
Raw / graded | “Raw / graded”, grade companies PSA BGS CGC SGC ACE TAG, “slab” in the cert hint | Right. Don’t add a fake company list. “Other” plus a name is enough.
Reverse holo | “Reverse holo”, tile chip “Rev” | Right for a collector. TCGplayer’s listing string is “Reverse Holofoil”; their help article says “Reverse Holo”. Do not switch the UI to Holofoil.
Holo | “Holo” | Right. TCGplayer says Holofoil. TCG Collector’s rarity string is “Rare Holo”, which is a rarity, not a print. Don’t merge those.
1st edition | “First edition”, chip “1st” | Chip is right. Long label should be “1st edition”, not “First edition”.
Unlimited | Not said. Normal is the other chip. | When 1st edition is one of the choices, Normal is unlimited. One caption on that sheet: “Normal means not 1st edition.” Don’t add an Unlimited chip; the enum doesn’t have one.
Shadowless | “Shadowless”, chip “Shdwl” | Long name is right. Kill “Shdwl”.
Stamp / pokeball / masterball | “Stamped promo”, free-text variant detail | Collectors say “stamp”, “Poké Ball”, “Master Ball”. The free-text field is the right place. Don’t invent enum labels for prints the catalog doesn’t list. Placeholder should name stamp / cosmos holo / misprint, not “variant detail”.
Collector number | `136/189`, or `#136` when the official count is 0 | Right. Never `001/000`. TCG Collector writes the same `n/total`. TCGplayer says “card number”. “Collector number” is the better phrase. Keep it.
Set symbol | Shown as a logo, not named | Fine. Don’t add a “set symbol” label.
EN / JA | EN and JA | EN is right. JA should be JP on screen.
Secret rares | “+ 12 secret” | Understandable. “secret rare” is the full phrase if the line wraps anyway. Not urgent.

## Legal and privacy — do not rewrite, with flags

Kept verbatim, and they match the sources:

- `DISCLAIMER` is the BRIEF sentence, character for character, including “The Pokémon Company”. It is on About (`about-disclaimer`) and at the bottom of Settings. The notice step shows the same constant.
- `DISCLAIMER_SECONDARY` is extra, not a BRIEF sentence. It is not false. Leave it.
- Privacy summary and sections in `lib/legal.ts` match the “we don’t collect, TCGdex sees the IP, no account” design. Last updated 31 October 2026.
- TCGdex MIT note says the licence does not cover card artwork. That matches `THIRD_PARTY_NOTICES.md` and the compliance research. Pokeum is correctly absent: no Pokeum code was copied.
- “This version does not use the camera or the photo library, and asks for no permissions.” True for Phase 1.

Flags, not rewrites:

1. Backup sentence in the app: “Your collection is included in your device backup. The card catalog is not — it re-downloads.” `apps/mobile/capacitor.config.ts` is written so the user database stays in the plugin default (backed up) and catalogs go to `Library/NoCloud` (excluded). That matches the sentence. `scripts/ios-notes.md` still has the device check unticked. `docs/PRIVACY-POLICY.md` still has the old bracket that assumes `Library/CapacitorDatabase` is not backed up. Do not publish that draft. Do not change the in-app sentence until a device check says the config is wrong. [needs owner input] if the published policy must wait on that check.
2. In-app privacy says catalogs are removed via “Settings → Remove a downloaded catalog.” The row exists, under Danger zone, with that label. Close enough. Not a factual error.
3. In-app privacy names “the host that serves FlashyDex catalog downloads” and does not name the host. True, vague. The docs draft does not mention that host at all. If packs are served from GitHub Releases, the published policy should name GitHub. [needs owner input] Do not guess the host in the app string.
4. In-app privacy has no publisher name and no contact email. The docs draft still has those as brackets. App Review wants a privacy-policy URL and a way to reach the developer. [needs owner input]
5. Notice line “FlashyDex doesn’t collect any data.” is true of FlashyDex and incomplete about TCGdex. The previous paragraph already names TCGdex. Leave the sentence. Don’t add a second disclaimer.
6. Step 1 Skip records `disclaimerAcknowledged` without showing the sentence. That is the one legal-adjacent string that should change, and it is in the table above. The sentence itself stays verbatim.

## [needs owner input]

No brand-voice doc exists. The voice above is inferred from the built app and from UX.md. Confirm or correct it before store text is pasted.

Tagline, already in the app, and the one to keep: “Your card collection, in your pocket.”

Do not use Pokémon, Nintendo, Pokédex, or a character name in the name, subtitle, or keywords (`docs/APP-STORE-COMPLIANCE.md`). Apple’s Subtitle field is 30 characters, not 170. Source: Apple’s App Store Connect app-information page, fetched 2026-10-31, “This can’t be longer than 30 characters.” The 170-character line is a proposal for a longer field. Do not paste it into Subtitle.

Subtitle, 25 characters, proposal:

Your cards, on your phone

170-character line, 111 characters, proposal:

Track the cards you own — condition, grade, and what you paid. No account. Your collection stays on this phone.

Description, 1491 characters, under 4000, proposal. It includes the affiliation sentence, which contains Nintendo and The Pokémon Company. That sentence is required in the app. Whether it may also appear in store metadata is a legal call. If it may not, delete the last paragraph and do not replace those names with a hint.

FlashyDex keeps a card collection on your phone. No account. No ads. Nothing you type is sent to us.

Search a catalog you download, add the copies you own, and record the print, condition, grade, and what you paid. Name the binders and boxes they live in. See the sets you collect, and which cards in those sets you still need.

After the catalog is on the device, search and editing work offline. Card pictures need a connection the first time, and some older Japanese cards have no picture in the catalog yet.

Estimated value uses TCGplayer prices in US dollars and Cardmarket prices in euros, via TCGdex. Each price is shown with its date. If there is no price, FlashyDex shows nothing — not zero. Graded copies are not priced automatically; you can enter your own. Currencies are not converted.

You can import a FlashyDex JSON export or a CSV, share a JSON or CSV of what you own, and back up your collection, settings, and custom cards to a file you keep. The card catalog is not in that backup. It downloads again.

This version does not scan cards. Camera scanning is planned for a later update. Until then, add cards by name or collector number. FlashyDex does not upload your collection, sell cards, or take payment.

FlashyDex is not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company. Card names and images come from TCGdex and are shown so you can identify cards you own. FlashyDex is not affiliated with TCGplayer or Cardmarket. Prices may be out of date.

Other owner calls, not copy:

- Publisher legal name and the email on the privacy policy.
- Whether the backup sentence ships before the iOS backup check in `scripts/ios-notes.md` is ticked.
- The hostname of catalog downloads, so the privacy policy can name it.
- Whether store description may include the affiliation sentence.

## Verified

- String inventory: Python walk of `apps/mobile/src` routes, components, and lib, written to scratch, then read. Counts and sentences above were checked against the source files, not against the inventory alone.
- `https://127.0.0.1:3200` and `https://10.0.0.4:3200` return HTTP 200. `http://` on port 3200 returns an empty reply.
- Browser, session `grok`, 390×844, `Security.setIgnoreCertificateErrors`: title FlashyDex, body “Opening your collection…”, and no further route. jeep-sqlite entry script did not complete.
- TCGplayer condition names and the DM abbreviation: TCGplayer condition API docs, search result 2026-10-31.
- Apple subtitle cap: 30 characters, developer.apple.com app-information page, curl 200, 2026-10-31.
- Description and subtitle lengths: `len()` on the exact strings, 25 / 111 / 1491.

## Incomplete

- Did not see welcome, add, collection, a card, sets, settings, catalog, data, or about painted. If a string is built only at runtime from data (a toast after a real add, a manifest size, a price date), it was read from the template, not from the screen.
- Did not open Collectr or TCG Collector in a logged-in session. Variant names for those products are from their public pages and from collector descriptions, not from a click-through of their add sheet.
- Did not confirm the 170-character promotional-text cap on this fetch. The 111-character line is inside the limit the task asked for. It is not labeled as an App Store field name.
