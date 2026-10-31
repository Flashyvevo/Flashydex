# App Store and Play compliance — FlashyDex

Fetched 2026-10-31 UTC. This is a build checklist, not legal advice. Guideline quotes are from the live page, not from memory. If a later page disagrees, the later page wins.

Primary source: App Review Guidelines, last updated 16 October 2026.
https://developer.apple.com/app-store/review/guidelines/
News note for that revision: https://developer.apple.com/news/?id=92th7e5i

Product facts this checklist assumes (from BRIEF.md, not re-litigated here): local-first SQLite, no owner server required, no accounts, no payments, no analytics, catalog from `api.tcgdex.net` and `assets.tcgdex.net`, Capacitor shell, camera is Phase 3, on-device model download is Phase 2.

Owners: `ui` (screens and copy), `core` (data and sync), `tooling` (native project, plist, store metadata files), `owner-manual` (accounts, questionnaires, legal sign-off). A row can have more than one.

## How a reviewer will actually use the app

There is no login, so Guideline 2.1 does not require a demo account or a demo mode. The reviewer must be able to sync the catalog from TCGdex on Apple's network and then use search, add, edit, and export with no server of ours running. Put that in Notes for Review. A bundled sample catalog is not required by the guideline text; it is a practical hedge if TCGdex is slow during review. [owner to confirm] whether Phase 1 ships a seed database.

---

## 4.2 Minimum Functionality

Citation: https://developer.apple.com/app-store/review/guidelines/#minimum-functionality

Quoted, 4.2: "Your app should include features, content, and UI that elevate it beyond a repackaged website. If your app is not particularly useful, unique, or “app-like,” it doesn’t belong on the App Store."

4.2.2: "Other than catalogs, apps shouldn’t primarily be marketing materials, advertisements, web clippings, content aggregators, or a collection of links."

4.2.3(i): "Your app should work on its own without requiring installation of another app to function."

4.2.3(ii): "If your app needs to download additional resources in order to function on initial launch, disclose the size of the download and prompt users before doing so."

4.2.7(e), remote-desktop rule, included because people confuse it with web wrappers: "Thin clients for cloud-based apps are not appropriate for the App Store."

What it means: a Capacitor app that only loads a remote site, or that is an empty shell until the owner's home server answers, fails 4.2. A local collection manager with on-device search, add, and export is the utility. The first catalog sync is a 4.2.3(ii) download.

Requirement:

- The shipped binary contains the UI. It does not point `server.url` at a dev machine or a hosted website. `capacitor.config` server URL is dev-only and must not be in the release config.
- No feature in Phase 1 calls the owner's server. Sync talks to TCGdex from the device.
- First-run sync UI states that a catalog download is required, gives a size or an honest "size unknown, this can take a long time" if we cannot measure it, and does not start the crawl until the user confirms. [owner to confirm] the wording if we cannot know the byte size up front.
- Native feel: no browser chrome, no full page reloads, share sheet and haptics through Capacitor plugins (see `.agent/research/capacitor-plugins.md`), safe areas, instant tab switches. That is a product requirement in BRIEF and the practical answer to "repackaged website."
- Do not ship as a thin client of a future recognition server. Phase 2 on-device recognition must work without that server, or the server path must not be the only path.

Verify: release build on a phone with no dev server running; airplane mode after a sync still opens the collection; `capacitor.config` in the iOS project has no remote `server.url`; first launch shows the download prompt before any TCGdex card crawl.

Owner: ui (prompt, navigation), core (sync does not need our server), tooling (release config).

## 2.1 App Completeness

Citation: https://developer.apple.com/app-store/review/guidelines/#app-completeness

Quoted, 2.1(a): "Submissions to App Review, including apps you make available for pre-order, should be final versions with all necessary metadata and fully functional URLs included; placeholder text, empty websites, and other temporary content should be scrubbed before submission. Make sure your app has been tested on-device for bugs and stability before you submit it, and include demo account info (and turn on your back-end service!) if your app includes a login. If you are unable to provide a demo account due to legal or security obligations, you may include a built-in demo mode in lieu of a demo account with prior approval by Apple. Ensure the demo mode exhibits your app’s full features and functionality. We will reject incomplete app bundles and binaries that crash or exhibit obvious technical problems."

What it means: demo mode is the exception for apps that have a login and cannot hand over an account. FlashyDex has no login. Do not build a demo mode to satisfy 2.1. Do make the real app usable by a stranger on Apple's network.

Requirement:

- No "lorem", no placeholder prices, no fake cards, no "coming soon" buttons that crash. Empty states are empty states (BRIEF).
- Support URL and privacy policy URL in App Store Connect resolve. Privacy policy is also inside the app (5.1.1(i), below).
- Notes for Review: no account; catalog syncs from public `https://api.tcgdex.net`; images from `https://assets.tcgdex.net`; after sync the app works offline; no in-app purchases. Name the steps: open app, confirm catalog download, search a card, add it, export.
- Test on a real device before submit. Guideline 2.1 rejects crashing binaries.

Verify: a person who is not the owner follows the review notes on a clean install over cellular, without the owner's LAN. Crash-free on that path.

Owner: owner-manual (notes, URLs), ui (no placeholders), core (sync path).

Related, 2.3.1(a): new features must be described specifically in Notes for Review. Generic "bug fixes and improvements" is fine only for bugfix builds (2.3.12). https://developer.apple.com/app-store/review/guidelines/#accurate-metadata

## 2.5.2 No downloaded executable code, and Phase 2 models

Citation: https://developer.apple.com/app-store/review/guidelines/#software-requirements

Quoted, 2.5.2: "Apps should be self-contained in their bundles, and may not read or write data outside the designated container area, nor may they download, install, or execute code which introduces or changes features or functionality of the app, including other apps. Educational apps designed to teach, develop, or allow students to test executable code may, in limited circumstances, download code provided that such code is not used for other purposes. Such apps must make the source code provided by the app completely viewable and editable by the user."

Phase 1: the app does not download JavaScript, WASM runtimes, or plugins after install. The web assets and sql.js wasm ship in the binary. A catalog `.sqlite` or JSON download is data. Do not `eval` downloaded strings. Do not hot-update the Capacitor web bundle from a server (that is downloaded code that changes functionality).

Phase 2 models: Apple publishes a supported path for downloading a Core ML model and compiling it on device. Quoted from https://developer.apple.com/documentation/coreml/downloading-and-compiling-a-model-on-the-user-s-device.md : "Install Core ML models on the user’s device dynamically at runtime." The page says to download the `.mlmodel` with URLSession or similar, then `MLModel.compileModel(at:)`. It also says compiled models should be excluded from iCloud Backup if they are large (`isExcludedFromBackup`).

What I could not confirm: Apple has not, in any page fetched for this note, written the sentence "ONNX weights are data, not code" or "onnxruntime-web model files are exempt from 2.5.2." The Core ML page is the closest official analog: a model file interpreted by code already in the app. An ONNX file run by `onnxruntime-web` or a mobile ORT build that shipped in the binary is the same shape. It is not the same document. Do not treat this note as Apple's approval.

Requirement if Phase 2 downloads a model:

- The interpreter (ONNX Runtime) is in the binary reviewed by Apple. The download is weights only. No downloaded JS, no downloaded wasm that was not in the reviewed binary, no plugin loader.
- The model must not add a feature the reviewer could not see. 2.5.19 (same guidelines page): "Don’t include any hidden, dormant, or undocumented features in your app." If recognition ships later, it is an update, described in What's New, not a silent download that turns on a hidden screen.
- 4.2.3(ii) still applies: tell the user the download size and ask first.
- Exclude the model file from iCloud Backup, following the Core ML page's instruction for large models.

Verify (Phase 2, not Phase 1): the download URL returns an ONNX or Core ML file, not a JS bundle; a strings/search of the download path shows no `eval` and no Capacitor live-update. Phase 1 verify: no code-download path exists.

Owner: core (Phase 2 design), tooling (no live-update plugin), owner-manual (if App Review asks, point at the Core ML analog and state the interpreter is bundled). [owner to confirm] before relying on this for a Phase 2 submission.

Also 2.5.4: background modes only for their intended purpose. Phase 1 sync is foreground only (BRIEF). Do not add `fetch` background mode to keep a crawl alive.

## 5.1.1 Privacy, data collection, and nutrition labels

Citation: https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage
Label rules: https://developer.apple.com/app-store/app-privacy-details/

Quoted, 5.1.1(i): "All apps must include a link to their privacy policy in the App Store Connect metadata field and within the app in an easily accessible manner." The policy must identify what data, if any, is collected, how, and all uses; confirm third parties with whom the app shares user data will protect it; explain retention and deletion and how a user revokes consent or requests deletion.

5.1.1(ii): purpose strings must "clearly and completely describe" the use. Writing guide: https://developer.apple.com/help/app-review/guideline-reference/5-1-1-purpose-strings — one brief sentence, active voice, a concrete example, not "to improve your experience."

5.1.1(iii): "Apps should only request access to data relevant to the core functionality of the app... Where possible, use the out-of-process picker or a share sheet rather than requesting full access to protected resources like Photos or Contacts."

Label definitions, quoted:

- "Collect" means "transmitting data off the device in a way that allows you and/or your third-party partners to access it for a period longer than what is necessary to service the transmitted request in real time."
- "Third-party partners" means "analytics tools, advertising networks, third-party SDKs, or other external vendors whose code you’ve added to your app."
- "Data that is processed only on device is not “collected” and does not need to be disclosed."
- "if an authentication token or IP address is sent on a server call and not retained, or if data is sent to your servers then immediately discarded after servicing the request, you do not need to disclose this."
- If you collect and store IP addresses, declare the type that matches how you use them (the page's example list includes diagnostics).

What it means for FlashyDex:

- Collection rows, notes, prices the user typed, and the catalog cache stay on device. That is not "collected" under the definition above.
- We add no analytics SDK, no ads SDK, no tracking domain. `NSPrivacyTracking` should be false. Do not call App Tracking Transparency; we do not track.
- The app does make HTTPS requests to TCGdex. Those requests are not "code you've added" from TCGdex; they are calls to someone else's server. The device IP is visible to that server. Whether that is "collected" depends on whether TCGdex retains it longer than the request. I did not find a TCGdex privacy policy on 2026-10-31 (see the report). [owner to confirm] before answering the nutrition-label question.
- Honest default if TCGdex does not retain identifiable request data, and we add no SDK that does: answer that the app does not collect data. The product page then shows the "not collected" style label. Do not tick that box on a guess.
- If TCGdex retains IPs or query logs, the label may need a diagnostics or identifier type, not linked to identity, used for app functionality, not used for tracking. That is the owner's call after reading their policy, not a number I can invent.
- Privacy manifest: apps and third-party SDKs can ship `PrivacyInfo.xcprivacy`. https://developer.apple.com/documentation/bundleresources/privacy-manifest-files.md Required-reason APIs (UserDefaults, file timestamps, disk space, boot time) must be declared if used. Capacitor Preferences uses UserDefaults. I did not open each plugin's xcprivacy file. Tooling must generate the Xcode privacy report on the first archive and fix missing reasons before submit.

Requirement:

- Host `docs/PRIVACY-POLICY.md` (after the owner fills the brackets) at a public HTTPS URL. Put that URL in App Store Connect and in Settings.
- No account fields, no email gate, no optional "send us feedback" that posts to us unless the policy and the label are updated first.
- Photos: Phase 3 uses the system picker / Capacitor Camera, not broad photo-library access, unless a feature truly needs the library. See usage strings below.
- Do not send collection contents to TCGdex. Sync requests are catalog GETs.

Verify: proxy or Charles log of a session shows only `api.tcgdex.net` and `assets.tcgdex.net` (plus Apple's own endpoints). No other host. Privacy report from Xcode has no undeclared required-reason API. App Privacy answers in App Store Connect match that log.

Owner: owner-manual (label answers, hosted URL), tooling (privacy manifest, no extra SDKs), core (request allowlist), ui (policy link in Settings).

## 5.1.1(v) Account deletion — not applicable

Citation: same guidelines anchor, and https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion

Quoted, 5.1.1(v): "If your app doesn’t include significant account-based features, let people use it without a login. If your app supports account creation, you must also offer account deletion within the app. Apps may not require users to enter personal information to function, except when directly relevant to the core functionality of the app or required by law."

FlashyDex does not support account creation. Account deletion is not applicable. Do not add a fake "delete account" screen. Do not require a name or email to open the app (5.1.1(x) allows an optional request; we are not making one).

If a later phase adds accounts, deletion must be in the app, easy to find, and must not be an email-only support flow. The help page says apps outside highly regulated industries should not require a phone call, email, or chat to finish deletion.

Verify: no sign-in screen; no account table; Settings has export and a way to delete local data (uninstall, and an in-app "erase this device's data" if we want one — not required by 5.1.1(v)).

Owner: core (no accounts), ui (don't add a login).

## 5.2 Intellectual Property, and what other TCG apps do

Citation: https://developer.apple.com/app-store/review/guidelines/#intellectual-property

Quoted, 5.2: "Make sure your app only includes content that you created or that you have a license to use. Your app may be removed if you’ve stepped over the line and used content without permission."

5.2.1: "Don’t use protected third-party material such as trademarks, copyrighted works, or patented ideas in your app without permission, and don’t include misleading, false, or copycat representations, names, or metadata in your app bundle or developer name."

5.2.2: "If your app uses, accesses, monetizes access to, or displays content from a third-party service, ensure that you are specifically permitted to do so under the service’s terms of use. Authorization must be provided upon request."

Also 2.3.7: "don’t try to pack any of your metadata with trademarked terms, popular app names, pricing information, or other irrelevant phrases just to game the system. App names must be limited to 30 characters."

2.3.9: "You are responsible for securing the rights to use all materials in your app icons, screenshots, and previews."

2.3.10: don't include names, icons, or imagery of other mobile platforms in the app or metadata.

Pokémon Company's own terms (https://www.pokemon.com/us/legal/terms-of-use , fetched 2026-10-31) say content on their service is their property, and the grant to the reader is "personal, noncommercial home use only." That page is their website terms, not a license for our app. Their footer on https://www.pokemon.com/us/legal states: "Pokémon, Pokémon character names, Nintendo Switch, ... are trademarks of Nintendo." and "© 2026 Pokémon. © 1995–2026 Nintendo/Creatures Inc./GAME FREAK inc."

TCGdex: the cards-database repo LICENSE is MIT, copyright 2021 TCGdex (https://raw.githubusercontent.com/tcgdex/cards-database/master/LICENSE). MIT covers that repository's software and files. It is not a grant of Nintendo's copyright in card artwork. The FAQ (https://tcgdex.dev/faq) says images are hosted separately and an `image` field appears when an image has been contributed. It does not grant a license to display those images in a commercial app. 5.2.2 is the open item. [owner to confirm] with a lawyer before submission. I am not that lawyer.

What shipped apps actually say, iTunes Search API, 2026-10-31, country=us:

- Dex — for TCG Collectors, trackId 1555489854, seller Pedro Carrasco, https://apps.apple.com/us/app/dex-for-tcg-collectors/id1555489854 . Description calls itself "the ultimate unofficial app for Pokémon TCG collectors" and ends: "Disclaimer: The text and imagery related to the Pokémon Trading Card Game, including card images, are copyrighted materials owned by The Pokémon Company. Please note that Dex is an independent application and is neither produced, endorsed, supported, nor associated with The Pokémon Company."
- Collectr, trackId 1603892248, seller Collectr Inc, https://apps.apple.com/us/app/collectr-tcg-collector-app/id1603892248 . The iTunes description uses the word "Pokemon" in a list of games. It does not contain "not affiliated", "Nintendo", or "disclaimer". It links https://getcollectr.com/terms-and-conditions.html . I did not fetch that page.
- Pokellector, trackId 600580227, https://apps.apple.com/us/app/pokellector-card-collector/id600580227 . The iTunes description does not include the disclaimer. The app links https://www.pokellector.com/terms . That page's footer, fetched the same day: "The Pokellector Website and Mobile Applications are not affiliated with, sponsored or endorsed by, or in any way associated with Pokemon or The Pokemon Company International Inc."
- TCG Collector the website, https://www.tcgcollector.com/ , footer: "The information presented on this website about the Pokémon Trading Card Game, including images and text, is intellectual property of The Pokémon Company, Nintendo, Game Freak, Creatures and/or Wizards of the Coast. TCG Collector is not produced by, endorsed by, supported by, or affiliated with any of these companies." iTunes search for "TCG Collector" did not return that site as an app. It returned Collectr and an unrelated "TCG Collector: Deckex".
- An extra listing, not requested but relevant: TCG Card Scanner for Pokemon, trackId 6711355393, description says the app "is not affiliated with, sponsored or endorsed by, or in any way associated with The Pokemon Company International inc. / Nintendo/Creatures Inc. / GAME FREAK inc."

Precedent is "unofficial app plus a disclaimer, and card images in the product." Precedent is not permission. Several of those names use Pokémon-derived words. BRIEF forbids Pokémon/Nintendo trademarks and character art in the app name, icon, splash, and store screenshots. Follow BRIEF. It is stricter than what those listings do, and it matches 2.3.7 and 5.2.1 better than copying their titles.

Requirement:

- App name FlashyDex (9 characters, under the 30-character cap). No "Pokémon", "Nintendo", "Pokédex", or character names in the name, subtitle, keywords, icon, splash, or screenshot overlays.
- In-app disclaimer, exact sentence from BRIEF, on an About screen that is reachable without adding a card: "FlashyDex is not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company."
- Card names and art inside the app are catalog data from TCGdex. Show them only if the owner accepts the 5.2.2 risk. Do not copy card art into the icon or the App Store screenshots.
- Developer name in App Store Connect must not imply Nintendo or The Pokémon Company (5.2.1, and 5.6.2 on accurate developer identity).
- Icon: original mark. HIG says prefer illustrations to photos, and "Don’t use replicas of Apple hardware products." https://developer.apple.com/design/human-interface-guidelines/app-icons.md

Verify: screenshot and icon review by the owner before upload; `rg -i "pokémon|pokemon|nintendo|pokédex" ` over store metadata files and icon assets returns nothing; About screen contains the sentence.

Owner: owner-manual (legal sign-off, developer name), ui (About, no marks in chrome), tooling (metadata files).

## 1.2 User-generated content — not applicable in Phase 1

Citation: https://developer.apple.com/app-store/review/guidelines/#user-generated-content

Quoted: "Apps that enable users to create, generate, upload, share, or otherwise contribute content present particular challenges... To prevent abuse, such apps must include: a method for filtering objectionable material... a mechanism to report offensive content... the ability to block abusive users... published contact information."

Custom cards and notes are typed by the user and stored on the device. They are not uploaded to us and not shown to other people. That is not a UGC platform. 1.2's filter/report/block duties do not apply.

If a later phase lets users publish cards or notes to other users, 1.2 applies in full, including the October 2026 clarification that failing to moderate can be a Developer Code of Conduct issue. Do not add sharing without that work.

Verify: no upload of notes or custom cards to a server we operate. Export is a file the user shares themselves.

Owner: core. Revisit if Phase 7 sync replicates custom cards to a multi-user server. A user's own server that only they can read is still not 1.2, but say so in review notes if that ships.

## 3.1 Payments — none

Citation: https://developer.apple.com/app-store/review/guidelines/#payments

Quoted, 3.1.1: "If you want to unlock features or functionality within your app, (by way of example: subscriptions, in-game currencies, game levels, access to premium content, or unlocking a full version), you must use in-app purchase. Apps may not use their own mechanisms to unlock content or functionality, such as license keys..."

Phase 1 has no purchases, no unlock, no subscription, no tip, no "pro" flag. Do not add a license key. Do not link out to pay for digital features. Physical card purchases are not in Phase 1; if they ever are, that is 3.1.5 territory and needs its own reading. Not this checklist.

2.1(b) (in-app purchases must be reviewable) does not apply because there are none.

Verify: no StoreKit, no product ids, no paywall. App Store Connect has no IAP.

Owner: core, tooling.

## 4. Design

Citation: https://developer.apple.com/app-store/review/guidelines/#design

Quoted, section 4 intro: "Apple customers place a high value on products that are simple, refined, innovative, and easy to use, and that’s what we want to see on the App Store. Coming up with a great design is up to you, but the following are minimum standards for approval to the App Store. And remember that even after your app has been approved, you should update your app to ensure it remains functional and engaging to new and existing customers. Apps that stop working or offer a degraded experience may be removed from the App Store at any time."

4.1(a): don't copy another app's name or UI and pass it off as your own. Do not clone Dex or Collectr's icon or layout.

BRIEF already requires dark default, thumb-reachable nav, 63:88 card art, no horizontal scroll at 390px, Dynamic Type-friendly rem scale, VoiceOver labels, safe-area insets. Those are the concrete 4.0 bar for this app. Also 2.4.1: "iPhone apps should run on iPad whenever possible." A Capacitor iPhone target that letterboxes on iPad is weaker than one that uses the width. [owner to confirm] iPhone-only vs universal. If the binary supports iPad, iPad screenshots are required (below).

4.5.4: push must not be required for the app to function. Phase 1 has no push. Don't add it as a gate.

Verify: VoiceOver pass on add-card and search; type size at the largest setting does not clip the primary button; safe area on a notched phone; iPad smoke test if the target includes it.

Owner: ui.

## 4.8 Login services — not applicable

Citation: https://developer.apple.com/app-store/review/guidelines/#login-services

Quoted: "Apps that use a third-party or social login service (such as Facebook Login, Google Sign-In, Log in with X, Sign In with LinkedIn, Login with Amazon, or WeChat Login) to set up or authenticate the user’s primary account with the app must also offer as an equivalent option another login service with the following features..." (limits data to name and email, private email, no ad use of interactions without consent).

No login of any kind. 4.8 does not apply. Do not add Sign in with Apple "just in case." Adding a third-party login later is what triggers the equivalent-option rule (Sign in with Apple is the usual way to meet it; the guideline text does not say the words "Sign in with Apple").

Verify: no auth SDK in package.json.

Owner: core.

## Export compliance and ITSAppUsesNonExemptEncryption

Citations:

- https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption.md
- https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations.md
- https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance
- https://developer.apple.com/help/app-store-connect/manage-app-information/determine-and-upload-app-encryption-documentation

Quoted, the key's discussion: "Set the value for this key to NO in your app’s Information Property List file to indicate that your app—including any third-party libraries you link against—either uses no encryption, or only uses encryption that’s exempt from export compliance requirements... Set the value to YES to indicate that your app uses non-exempt encryption."

If the key is absent, App Store Connect asks the encryption questions on every upload.

Quoted, complying-with-encryption page: "Typically, the use of encryption that’s built into the operating system—for example, when your app makes HTTPS connections using URLSession—is exempt from export documentation upload requirements, whereas the use of proprietary encryption is not." The same page: "If your app uses exempt forms of encryption, you might alternatively be required to submit a year-end self-classification report to the U.S. government."

HTTPS to TCGdex is the ordinary exempt case. That is not the whole binary.

`@capacitor-community/sqlite` README, fetched 2026-10-31 from https://raw.githubusercontent.com/capacitor-community/sqlite/master/README.md : "This plugin uses the SQLCipher library (even for unencrypted databases), which is subject to the Encryption Export Regulations and may require you to submit a year-end self-classification report to the U.S. government."

So: do not set `ITSAppUsesNonExemptEncryption` to `NO` just because we don't turn on database encryption. The library is linked either way. The owner answers the App Store Connect questions with SQLCipher in the binary, and sets the plist key to match that answer. If the answer is exempt-but-documentation-not-required, the key is `NO` and a year-end self-classification report may still be owed. If the answer is non-exempt, the key is `YES` and Apple issues `ITSEncryptionExportComplianceCode` after reviewing documents. I cannot pick the Boolean from the pages above. [owner to confirm]

Requirement: the key is present before the first TestFlight upload, set to the owner's answer, not omitted. Phase 1 does not enable `iosIsEncryption` / `androidIsEncryption` unless the owner wants encrypted databases. Turning encryption on does not remove the SQLCipher question; the README says the library is linked even when encryption is off.

Verify: Info.plist contains the key; the value matches the App Store Connect encryption answer on file; no second encryption library sneaks in.

Owner: owner-manual (questionnaire, possible BIS report), tooling (plist).

## Info.plist usage strings

Citations:

- https://developer.apple.com/documentation/bundleresources/information-property-list/nscamerausagedescription.md — "This key is required if your app uses APIs that access the device’s camera."
- https://developer.apple.com/documentation/bundleresources/information-property-list/nsphotolibraryusagedescription.md — required if the app reads or writes the photo library. If the app only adds photos, use `NSPhotoLibraryAddUsageDescription` instead.
- https://developer.apple.com/documentation/bundleresources/information-property-list/nsphotolibraryaddusagedescription.md — required for write access.
- Camera plugin 7.0.5 README (https://unpkg.com/@capacitor/camera@7.0.5/README.md) requires all three keys if that plugin is linked.
- 2.5.14: "Apps must request explicit user consent and provide a clear visual and/or audible indication when recording, logging, or otherwise making a record of user activity. This includes any use of the device camera..."

Phase 1 does not use the camera. Do not link `@capacitor/camera` in the Phase 1 binary, and do not add the keys until the plugin is linked. Empty or unused purpose strings are a review smell. Draft the strings now so Phase 3 is not blocked.

Draft strings, one sentence, active voice, concrete (purpose-string guide):

- NSCameraUsageDescription: "FlashyDex uses the camera to photograph a card so it can match the card and add it to your collection on this device."
- NSPhotoLibraryUsageDescription: "FlashyDex uses a photo you choose so it can match that card and add it to your collection on this device."
- NSPhotoLibraryAddUsageDescription: only if we save a scan back to Photos. Phase 3 as specified does not need to write to Photos. Omit the key unless that feature exists. 5.1.1(iii) prefers the picker over full library access.

Android, when camera ships: Capacitor Camera 7 uses the Android Photo Picker for existing images (plugin README). Play policy: apps targeting API 33+ may request `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` only if the system picker is not enough. https://support.google.com/googleplay/android-developer/answer/14115180?hl=en Quote: "Apps that target Android 13 or later (API level 33+) may only request the READ_MEDIA_IMAGES and READ_MEDIA_VIDEO permissions if system pickers (like the Android Photo Picker), are not sufficient for your app to provide core functionality." Do not add those permissions for a one-card pick.

Other plist keys that are not usage strings but are Xcode-side:

- Status bar plugin 7.0.6: `UIViewControllerBasedStatusBarAppearance` = YES. https://unpkg.com/@capacitor/status-bar@7.0.6/README.md
- Filesystem 7.1.9: `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` only if files should appear in the Files app. Do not set those for the collection database. Export goes through the share sheet.

Verify: Phase 1 Info.plist has no camera or photo keys. Phase 3 build has the two read strings, the system permission dialog shows that exact text, and a denied camera still allows manual search (5.1.1(iv)).

Owner: tooling (plist), ui (string copy), owner-manual (Phase 3 review notes mention the camera).

## Icons, including the iOS 18 variants and what replaced them

Citations:

- https://developer.apple.com/design/human-interface-guidelines/app-icons.md (HIG, changelog line "June 10, 2024: Added guidance for creating dark and tinted app icon variants for iOS and iPadOS." Later lines: June 9, 2025 layered Liquid Glass; June 8, 2026 refined Liquid Glass.)
- https://developer.apple.com/documentation/xcode/configuring-your-app-icon.md

iOS 18 added dark and tinted variants. That requirement did not go away. The current HIG is stricter.

HIG, quoted: "In iOS, iPadOS, and macOS, people can choose whether their Home Screen app icons are default, dark, clear, or tinted in appearance... You can design app icon variants for every appearance variant, and the system automatically generates variants you don’t provide."

Spec table on that page, iOS/iPadOS/macOS: 1024x1024 px, layered, appearances "Default, dark, clear light, clear dark, tinted light, tinted dark."

Xcode asset-catalog article still documents the older three wells: "iOS and iPadOS support three stylistic variations for app icons: Light, Dark, and Tinted." "Provide your tinted app icon as a grayscale image. Provide your dark app icon with a transparent background so the system-provided background can show through." It also says the system can auto-generate a treatment, and points at Icon Composer for the full set.

Requirement:

- 1024x1024 original icon. No character art, no Pokémon logo, no photo of a card, no Apple hardware.
- Prefer an Icon Composer file so dark, clear, and tinted are controlled. If tooling only fills the asset catalog, provide Any, Dark, and Tinted (tinted as grayscale, dark with transparent background) and let the system generate the rest. Check the generated clear/tinted variants on an iOS 18 or later device before submit; auto-generation can muddy a thin mark.
- Alternate icons, if any, need their own dark, clear, and tinted variants (HIG note). We don't need alternate icons.

Verify: icon set in `Assets.xcassets` or an `.icon` file; install on a device and switch Home Screen to Dark, Clear, and Tinted.

Owner: ui (art), tooling (asset catalog). owner-manual approves the mark.

## Screenshots

Citations:

- https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications
- Guideline 2.3.3, and https://developer.apple.com/help/app-review/guideline-reference/2-3-3-screenshots
- https://developer.apple.com/app-store/asset-best-practices/ (fetched; the page does not mention device frames)

Spec page, quoted: at least one screenshot, up to 10, `.jpeg` / `.jpg` / `.png`. "Images can’t include alpha channels or transparencies."

Required: "iPhone: At least one screenshot for iPhone with Dynamic Island (medium display)." iPad 13-inch "if your app supports iPadOS."

Medium Dynamic Island sizes accepted (iPhone 14 Pro through iPhone 18 Pro on that page):

- 1179 x 2556 and 2556 x 1179
- 1206 x 2622 and 2622 x 1206

If those are missing, App Store Connect scales from Face ID large. Don't rely on scaling for the required slot; upload the medium size.

iPad 13-inch, required if the app runs on iPad: 2064 x 2752, 2752 x 2064, 2048 x 2732, 2732 x 2048. The page says "Required if app runs on iPad."

2.3.3: "Screenshots should show the app in use, and not merely the title art, login page, or splash screen." Overlays are allowed if they don't hide the app. The help page says not to show only hardware or an overlay with no app behind it, and not to let marketing crowd out the UI. Status-bar references to other platforms are judged under 2.3.10.

Device frames: the specification page regulates pixels, format, and alpha. It does not say "no device frames" and it does not require frames. I will not invent a ban. A frame of a non-Apple device risks 2.3.10. Full-bleed captures of the app are the safe default. No card art and no Pokémon wordmarks in the overlays (2.3.9, BRIEF).

2.3.8: screenshot content must stay at a 4+ level even if the app is rated higher. Not a practical issue here. Do not put "For Kids" in the metadata (that phrase is reserved for the Kids Category).

Verify: files match one of the accepted pixel sizes; no alpha; first three show the collection, a card, and add/search, not the splash; owner looks at them before upload.

Owner: ui, owner-manual.

## Apple Developer Program

Citation: https://developer.apple.com/programs/

Quoted from that page: a free account can test on your own devices with Xcode. "Join the Apple Developer Program" is "$99 annual membership." "Enroll as an individual or organization." The Enterprise program is $299/year and is for private employee distribution. We do not want Enterprise.

Membership is what unlocks TestFlight and App Store distribution. The iOS build happens on the owner's Mac (BRIEF). Enrollment, agreements, tax, and banking are owner-manual. A free account is enough to compile to a personal phone; it is not enough to submit.

Verify: App Store Connect shows an active membership before the first upload.

Owner: owner-manual.

## TestFlight

Citations:

- https://developer.apple.com/testflight/
- Guideline 2.2: https://developer.apple.com/app-store/review/guidelines/#beta-testing

Quoted, 2.2: "Demos, betas, and trial versions of your app don’t belong on the App Store – use TestFlight instead. Any app submitted for beta distribution via TestFlight should be intended for public distribution and should comply with the App Review Guidelines... apps using TestFlight cannot be distributed to testers in exchange for compensation of any kind... Significant updates to your beta build should be submitted to TestFlight App Review before being distributed to your testers."

TestFlight page: up to 100 internal testers (Account Holder, Admin, App Manager, Developer, or Marketing). Up to 10,000 external testers. The first build added to an external group goes to TestFlight App Review. Testers use the TestFlight app. "Testers can access all available beta builds you’ve shared with them, on up to 30 devices."

I did not find a build-expiry number on the TestFlight marketing page I fetched. Do not quote "90 days" from this note.

Requirement: dogfood via TestFlight internal first. External testers only after the compliance rows above are true, because TestFlight review uses the same guidelines. No paid beta.

Verify: internal install on the owner's phone from TestFlight, not a cable-only debug build, before calling the app submittable.

Owner: owner-manual, tooling (archive, upload).

## Other guidelines that will get a build rejected if ignored

1.5 Developer Information. https://developer.apple.com/app-store/review/guidelines/#developer-information — "Make sure your app and its Support URL include an easy way to contact you." Settings and the support URL need a real email. [owner to confirm] which address.

2.5.5: "Apps must be fully functional on IPv6-only networks." TCGdex is public HTTPS. Verify on an IPv6-only NAT64 network or Apple's test, not assumed.

2.5.19: no hidden features. No debug menu that unlocks a server URL in the release build, or if it exists, it is documented in review notes and not a backdoor.

5.6.2: the developer name customers see must be true.

---

## Google Play

Shorter, because Play is later. Same product rules.

### Data safety

https://support.google.com/googleplay/android-developer/answer/10787469?hl=en

Quoted: "All developers must declare how they collect and handle user data for the apps they publish on Google Play... This includes data collected and handled through any third-party libraries or SDKs used in their apps." "All developers that have an app published on Google Play must complete the Data safety form, including apps on closed, open, or production testing tracks."

If the app doesn't collect or share user data, the listing shows that state. The page has a section titled "What users will see if your app doesn't collect or share any user data." Same caveat as Apple: answer it only after the TCGdex retention question is settled. Encryption-in-transit can be declared only if it covers every user-data transmission. Our HTTPS calls qualify if we declare any collection; if we declare none, the encryption question is about data we collect, which would be none.

The form is on Play Console, App content. Owner-manual. A wrong form is an enforcement issue; Google says they will not fill it in for you.

### Target API level

https://support.google.com/googleplay/android-developer/answer/11926878?hl=en

Quoted: "Starting August 31, 2026: New apps and app updates must target Android 16 (API level 36) or higher to be submitted to Google Play" (Wear, Automotive, TV, and XR have lower floors; we are a phone app). Extension to 1 November 2026 can be requested; the form was "later this year" as of the page fetch.

The sqlite plugin README's Android example still says `targetSdkVersion = 35`. Do not copy that. Tooling sets `targetSdkVersion` 36. I did not compile the plugin against API 36. That is a build task, not a verified fact.

### Intellectual property

https://support.google.com/googleplay/android-developer/answer/9888072?hl=en

Quoted: "We don’t allow apps or developer accounts that infringe on the intellectual property rights of others (including trademark, copyright, patent, trade secret, and other proprietary rights)." "We don’t allow apps that infringe copyright. Modifying copyrighted content may still lead to a violation. Developers may be required to provide evidence of their rights to use copyrighted content." "In general, the safest approach is to create something that’s original." Examples of violations include artwork from cartoons and "Reproductions or “fan art” indistinguishable from the original work under copyright."

Trademark section: use likely to cause confusion about source can get the app suspended. The same name/icon/screenshot rules as Apple apply. The disclaimer does not, by itself, satisfy this policy. [owner to confirm]

If the owner has written permission, Google asks developers to contact Play before submission (same page). We do not have that letter.

### Photo permissions

Same URL as the restricted-permissions page above. Use the photo picker. Do not request `READ_MEDIA_IMAGES` for scanning one card.

### Play checklist owner split

- owner-manual: Play Console account, Data safety form, content rating questionnaire, privacy policy URL.
- tooling: targetSdk 36, no broad photo permissions, release AAB.
- ui / core: same disclaimer, same no-account, same local data as iOS.

---

## Before the first upload

1. Owner fills the brackets in `docs/PRIVACY-POLICY.md` and hosts it.
2. Owner answers encryption with SQLCipher in mind and tooling writes the plist key.
3. Owner signs the IP risk: in-app TCGdex images yes or no. Store screenshots and icon stay free of Pokémon marks either way.
4. Notes for Review written. No demo account, because there is no login.
5. Clean-device test: install, prompt, sync from TCGdex, add a card, export, airplane mode, reopen.
