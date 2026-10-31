# Requests from Opus (UX v2) to other owners

UX.md has a working fallback for every item below, so none of them blocks Phase 1.

## To Sol (API / DATA-MODEL / ARCHITECTURE; Stage A3)
- **S1 CatalogPackService** (COMPRESSION-STORAGE). Needed calls:
  - `manifest()` → per language: version, compressedBytes, uncompressedBytes, cardCount, setCount
  - `install(lang)` and `cancel()`
  - `status()`, exposed as an observable
  - Stages: downloading (bytesDone/bytesTotal), verifying, installing, activating, ready, failed(reason: network|hash|size|schema|space), cancelled
  - `updateAvailable`, plus a flag saying whether HTTP Range resume is possible
  - `installedSize(lang)`
  - UX: §10.2, §15.5, §16.3.
- **S2** `SyncService.start` needs a `selection.scope:'owned'` for `prices_only` (Dashboard "Update prices for my cards"). Fallback: followed sets.
- **S3** Single-card and single-set refresh/fill-in. Either `refreshCard(CardKey)` or a selection of one set (Card Details `⋯`, Set detail).
- **S4** Queue semantics when `ActiveWorkError` fires: "start after current". Fallback: the button stays disabled with "Starts when the current download finishes" and the user taps again.
- **S5** Add `theme`, `haptics:boolean` and `searchLanguage` to AppSettings. Fallback: Capacitor Preferences/localStorage with the `ps-` prefix.
- **S6** `BackupService.lastBackup()` → { at, totalCards } for the "Last backup" line. Fallback: the line is hidden.
- **S7 (App Store risk):** state the iCloud/device-backup behaviour of `flashydex-user.db` and the catalog DBs.
  - Catalog DBs are re-downloadable. Apple's iOS Data Storage Guidelines (App Review 2.23) expect them in Caches or with `isExcludedFromBackup` set.
  - The user DB should be backed up.
  - The privacy text and the Data screen caption need the true answer.
- **S8** Two Danger-zone operations:
  - `removeCatalog(lang)` (allowed now that catalogs are replaceable files);
  - `eraseAllUserData({confirm:'ERASE'})`.
  - Fallback: both rows are hidden.
- **S9** A bundled bootstrap set index or a manifest set index (id, name, series, releaseDate, cardCount, language), so the first-run set picker works before any catalog is installed.
- **Route additions** for the ARCHITECTURE route table: `/settings/catalog`, `/settings/about`, `/settings/privacy`, `/settings/licenses`, `/welcome`, `/welcome/notice`, `/welcome/languages`, `/welcome/sets`.
- **HapticInput kinds:** Platform currently has selection|success|error. UX uses success, warning, error, selection, impactLight and impactMedium. Either extend the core enum or confirm that UI haptics live only in `apps/mobile/src/platform/haptics.ts`. UX assumes the latter.
- **Data point for the footprint estimate:** card-detail JSON averaged 2,054 bytes (12-card stratified sample). TCGdex sent no gzip even with `Accept-Encoding: gzip` (2026-10-30). Set details are 16–27 KB.
- **Conflict resolved in UX:** the add form's condition now defaults to null (API.md "UX mapping").
  - Kept: variant preselection by catalog priority, which is visible and confirmed by the Add tap. Director to confirm.

## To Terra (apps/mobile tooling, native projects)
- **T1** Add these plugins:
  - `@capacitor/network`
  - `@capacitor/keyboard` (iOS `resize:'none'`)
  - `@capacitor/text-zoom`
  - `@capacitor/browser`
- **T2** External links go through Browser only.
- **T3** Phones are portrait-only in Phase 1 (Info.plist and Android manifest). Owner decides iPhone-only vs universal (iPad screenshots are required if universal).
- **T4** Capacitor config:
  - `ios.contentInset: 'never'`. It is currently `'always'`, which breaks the env() safe areas.
  - `android.adjustMarginsForEdgeToEdge: 'force'`.
  - `backgroundColor: '#0b0d12'`.
  - SplashScreen `launchAutoHide:false`.
  - `index.html` theme-color `#0b0d12` (currently `#101114`).
  - `UIViewControllerBasedStatusBarAppearance=YES`.
- **T5** iOS edge-swipe back: a `CAPBridgeViewController` subclass setting `webView.allowsBackForwardNavigationGestures = true`. Optional: `@capacitor-community/keep-awake` for the long fallback crawl.
- **T6** A build-generated `licenses.json` (all bundled npm deps + their license texts) for `/settings/licenses`.
- **T7** Add `@fontsource-variable/inter`. Import `./tokens.css` from `globals.css` using the DESIGN-TOKENS §9 snippet.
- **T8** Icon and splash assets per DESIGN-TOKENS §10.3 ("foil glint"; no bolt, no ball). Generate iOS Light/Dark/Tinted (Icon Composer preferred), Android adaptive + monochrome, and the splash.
- **Note:** `apps/mobile/package.json` pins `@capacitor/core` 7.6.10 next to plugins at 8.x (app, filesystem, haptics, share, splash-screen, status-bar, sqlite 8.1.1). Capacitor 8 plugins need core 8. Align them to the 7.x lines.
