# Grok report — Stage A2, App Store / Play compliance

Role: research. No code. No commit. No file outside the ownership list was edited. "pokescan" does not appear in the files created here; they were new.

Fetched 2026-10-31 UTC with curl. Apple's guidelines page `Date` header was Sat, 31 Oct 2026. The guidelines themselves say last updated 16 October 2026.

## Produced

- `docs/APP-STORE-COMPLIANCE.md`
- `docs/PRIVACY-POLICY.md` (draft; brackets are owner choices, not legal advice)
- `.agent/research/capacitor-plugins.md`
- `.agent/reports/grok-appstore-report.md` (this file)

## Verified

App Review Guidelines HTML, 240818 bytes, `https://developer.apple.com/app-store/review/guidelines/`. Quoted in the compliance doc from that file, not from memory: 1.2, 1.5, 2.1, 2.2, 2.3.3, 2.3.7, 2.3.8, 2.3.9, 2.3.10, 2.4.1, 2.5.2, 2.5.4, 2.5.5, 2.5.14, 2.5.19, 3.1.1, 4 intro, 4.1, 4.2 through 4.2.3 and 4.2.7(e), 4.5.4, 4.8, 5.1.1(i) through (v) and (x), 5.2, 5.2.1, 5.2.2, 5.6.2. Last-updated line on the page points at `https://developer.apple.com/news/?id=92th7e5i`.

Apple help and docs, curl, same day:

- Privacy nutrition labels: `https://developer.apple.com/app-store/app-privacy-details/`
- Screenshot spec: `https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications` (the help site redirected the shorter URL here). Required iPhone slot is Dynamic Island medium, 1179x2556 or 1206x2622. iPad 13-inch 2064x2752 or 2048x2732 if the app runs on iPad. No alpha. The spec does not mention device frames. Asset best practices (`https://developer.apple.com/app-store/asset-best-practices/`) also does not. I did not invent a "no device frames" rule.
- 2.3.3 help: `https://developer.apple.com/help/app-review/guideline-reference/2-3-3-screenshots`
- Purpose strings: `https://developer.apple.com/help/app-review/guideline-reference/5-1-1-purpose-strings`
- Account deletion: `https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion`
- Encryption: Info.plist key markdown, complying-with-encryption markdown, overview and determine-and-upload help pages. HTTPS via the OS is described as typically exempt from documentation upload. A year-end self-classification report may still apply. The Boolean for our binary is not answered by those pages, because of SQLCipher (below).
- Usage-string key pages, markdown: `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription`.
- Icons: HIG markdown and Xcode asset-catalog markdown. iOS 18 dark/tinted is the 10 June 2024 changelog line. Current HIG (8 June 2026 line) also wants clear light/dark and tinted light/dark, 1024x1024, Icon Composer preferred. System can generate missing variants.
- Programs page: free account vs $99/year membership. Enterprise is $299 and the wrong program.
- TestFlight page: 100 internal, 10,000 external, first external build is reviewed, testers use the TestFlight app, up to 30 devices. Build-expiry days were not on that page.
- Core ML download page markdown: Apple documents downloading an `.mlmodel` and compiling it on device. No ONNX sentence.

npm dist-tags and selected version documents, same day. Capacitor 7 line is 7.6.10 for core, cli, ios, android. npm `latest` is 8.6.0. sqlite 7.0.3 peers `@capacitor/core >=7.0.0` and depends on `jeep-sqlite ^2.7.2`. sqlite 8.1.1 peers `>=8.0.0`. Plugin `latest-7` tags are in the plugins note. `@capacitor/cli@8.6.0` wants Node >= 22. jeep-sqlite 2.8.0, sql.js 1.15.2, onnxruntime-web 1.31.1, drizzle-orm 0.45.4.

Plugin READMEs via unpkg at the 7.x versions, plus sqlite master README and API.md, plus Drizzle sqlite-proxy `driver.ts` on GitHub main. SQLCipher is linked even for unencrypted databases (plugin README). iOS location `Library/CapacitorDatabase` is documented as not visible to iTunes and not backed up to iCloud. Default location is Documents. Database names gain a `SQLite` suffix. Share plugin only shares the Android caches folder unless `file_paths.xml` is extended. Status bar wants `UIViewControllerBasedStatusBarAppearance` = YES. Camera 7.0.5 lists three Info.plist usage keys. CapacitorHttp lives in `@capacitor/core`; patching `fetch` is off by default.

ONNX Runtime Web compatibility table: WASM marked supported on Safari (iOS); WebGPU marked not supported on Safari (iOS) or Safari (macOS). WebGPU tutorial says Safari Technology Preview, not shipping iOS Safari. WKWebView is not named.

iTunes Search API, country=us: Dex 1555489854 disclaimer quoted in the compliance doc. Collectr 1603892248 description has "Pokemon" and no affiliation disclaimer; it links getcollectr.com terms, which I did not fetch. Pokellector 600580227 links `https://www.pokellector.com/terms`, whose footer has the affiliation disclaimer. TCG Collector the site (`https://www.tcgcollector.com/`) has a footer disclaimer; iTunes did not return that product as an app.

Pokémon terms of use and the legal footer: trademarks and the personal-noncommercial grant are theirs, not a license to us. TCGdex cards-database LICENSE is MIT for that repo. FAQ does not grant an image license.

Google Play, same day:

- Data safety form required for every track, including closed testing. `https://support.google.com/googleplay/android-developer/answer/10787469?hl=en`
- Target API: new apps and updates must target Android 16 (API 36) from 31 August 2026, extension possible to 1 November 2026. `https://support.google.com/googleplay/android-developer/answer/11926878?hl=en`
- IP policy: copyright and trademark, fan-art reproductions called out as a violation example. `https://support.google.com/googleplay/android-developer/answer/9888072?hl=en`
- Photo permissions: `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` only if the photo picker is not enough. `https://support.google.com/googleplay/android-developer/answer/14115180?hl=en`

`developer.android.com/google/play/requirements/target-sdk` returned a redirect loop (curl exit 47). The Play Console help page above is the source for the API 36 date.

## Incomplete — not verified

- No Apple page fetched says "ONNX weights are data, not code" or names onnxruntime under 2.5.2. The compliance doc treats the Core ML download article as an analogy and says so.
- No TCGdex privacy policy and no TCGdex image license found. MIT on the cards-database repo is not that license. Nutrition-label "data not collected" is blocked on the retention question. Marked `[owner to confirm]`.
- Collectr's linked terms page was not fetched. Their App Store description, which was fetched, has no disclaimer.
- Did not download App Store screenshots, so I cannot say whether Dex or Collectr show card art in screenshots.
- Did not open plugin `PrivacyInfo.xcprivacy` files. First Xcode privacy report is the check.
- Did not fetch sqlite `docs/Web-Usage.md`. README says IndexedDB. OPFS was not in the README.
- Did not run a RETURNING statement or a Drizzle proxy against the plugin. The API type has a `values` field "when RETURNING". Untested.
- Did not read the Swift that sets backup exclusion. The published API doc is what I quoted.
- Did not read `@capacitor/cli@7.6.10` engines. Only 8.6.0's `node >= 22` was in the metadata I parsed.
- TestFlight build lifetime in days: not on the page I fetched. Not quoted.
- iOS splash Info.plist keys past the launch storyboard: the 7.0.5 README opening covers Android 12. I did not finish that README looking for an iOS key.
- sqlite plugin vs `targetSdkVersion` 36: the README example still says 35. I did not compile it.
- Camera plugin iOS sources: README requires three usage strings. I did not check whether omitting the add-only key crashes if we never save to Photos.
- Share plugin FileProvider authority after `cap sync`: the README states the caches-folder limit. I did not generate an Android project.
- WKWebView specifically: not in the ONNX docs. Safari (iOS) cells are what I quoted.
- Pokémon trademark-guidelines page as a separate document: `https://www.pokemon.com/us/legal` was a thin page; the terms-of-use page is what I quoted. I did not find a fan-content license that would cover this app.
- Google Play photo-policy page title is "Understanding Restricted Permissions with minimum scope alternatives". The photo section on it is what I quoted. I did not fetch a second, older photo-permissions URL.

## Open questions

1. Publisher legal name, contact email, privacy-policy URL, and whether julian@elevatedpeakmarketing.com is the right address.
2. Lawyer sign-off on showing TCGdex card images in the app. Store icon and screenshots stay free of Pokémon marks either way (BRIEF plus 2.3.7 / 2.3.9 / 5.2.1).
3. Encryption questionnaire with SQLCipher linked. Do not set `ITSAppUsesNonExemptEncryption` until that answer exists.
4. Does TCGdex retain IP or request logs? That answer picks the nutrition label and the Play Data safety form.
5. Stay on Capacitor 7.6.10, or move the brief to 8.6.0? Not decided here. Plugin majors do not mix.
6. iPhone-only or iPad screenshots too? 2.4.1 prefers iPad. The screenshot spec requires the 13-inch slot if the binary supports iPad.
7. Phase 1 seed catalog so review survives a TCGdex outage? 2.1 does not require a demo mode. It does require the app to work.
