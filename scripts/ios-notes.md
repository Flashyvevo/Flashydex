# Mac verification checklist (iOS first, Android equivalents below)

Everything native in FlashyDex was written on Windows and has only been type-checked and source-read. This list is what must be
proven on a Mac/iPhone before the storage design (docs/COMPRESSION-STORAGE.md, Director D18) counts as done. Tick each box and note the result.

## 1. Build and open

```bash
xcode-select --install          # once
npm install
npm run build && npx cap sync ios && npx cap open ios
```

- [ ] If CocoaPods complains: close Xcode, `cd apps/mobile/ios/App && pod install`, reopen `App.xcworkspace`.
- [ ] Signing: `App` target, bundle id `com.flashydex.app` (change if not final), owner's team, automatic signing.
- [ ] Deployment target / device families match the App Store release plan; portrait only.
- [ ] `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` read well for a reviewer.
- [ ] App launches on a real iPhone (not only the simulator) and reaches the home screen offline.

## 2. Export compliance (OWNER REVIEW NEEDED)

`@capacitor-community/sqlite` links SQLCipher (CommonCrypto-based AES) into the app binary even when database encryption is never
used. `Info.plist` currently sets `ITSAppUsesNonExemptEncryption = false` (answers "no non-exempt encryption" to App Store Connect).
That was the earlier plan's assumption, but because SQLCipher is linked it is a judgement call, not a settled fact.
The owner must review it before the first TestFlight/App Store submission and answer the App Store Connect encryption question
accordingly (exempt use vs. declaring encryption; some regions may need a self-classification). This note is not legal advice.

## 3. Catalog storage location and backup exclusion

Catalog packs install to `Library/NoCloud/flashydex/catalogs` (`Directory.LibraryNoCloud`; the Filesystem plugin sets
`isExcludedFromBackup = true` on `Library/NoCloud`, per source reading). `flashydex-user.db` stays in the SQLite plugin's default
location and MUST remain backed up. (Caches is the allowed alternative but is purgeable by iOS.)

- [ ] Install a pack (Settings -> Catalog, or `/dev/pack-test`). Confirm `catalog-<lang>.db` exists (plus `.previous.db` right after an update).
- [ ] Container inspection: Xcode -> Window -> Devices and Simulators -> select the iPhone -> FlashyDex -> `...` -> Download Container.
      Right-click the `.xcappdata` -> Show Package Contents -> `AppData/Library/NoCloud/flashydex/catalogs/`.
- [ ] Exclusion flag: on the Mac run `xattr -l <path>` on `NoCloud` and on `catalog-en.db`; an excluded item carries
      `com.apple.metadata:com_apple_backup_excludeItem`. Alternative: a temporary debug log in Swift,
      `try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup`, for the catalogs dir, each catalog file, and the user DB.
  - [ ] Catalogs directory and files: `true`. If only the directory is flagged and files report false, file a request to flag files too.
  - [ ] `flashydex-user.db` (usually `Library/CapacitorDatabase`; confirm the path): NOT excluded (`false` / no attribute).
- [ ] Optional: compare device backup size with and without a ~100 MB catalog installed.

## 4. Native catalog open and install semantics

- [ ] `createNCConnection` opens an externally written catalog (written by Filesystem, not created by the SQLite plugin) read-only, and queries return rows.
- [ ] Opening a missing file does not create an empty database.
- [ ] Atomic activate: staging -> active and active -> `.previous` are same-volume renames (same directory), instantaneous, no copy.
- [ ] Force-kill during install (swipe away / Xcode Stop) at: mid-download, mid-decompress, between the two renames. On relaunch the previous catalog still opens and works, the installer recovers to a consistent state, and no blank active DB appears.
- [ ] Reinstall (same and newer version) keeps `.previous` until the new catalog has been reopened, then cleans up.
- [ ] Real EN pack (~100 MB class): memory stays bounded during decompress (Instruments -> Allocations/VM Tracker; record peak for the metrics gate) and the UI stays responsive.
- [ ] Free-space preflight is SKIPPED on native: `@capacitor/filesystem` has no free-space API, so `availableBytes()` returns null. A real preflight needs a small native plugin. Until then, test a nearly full device: ENOSPC mid-install must leave the old catalog usable.
- [ ] Delete and reinstall the app: the catalog is gone (not restored from backup), user data comes back if the device backup includes it, and the app offers the catalog download.

## 5. Android equivalents

Catalogs live in `filesDir/flashydex/catalogs` and `flashydex/packs` (`Directory.Library`). `@capacitor/filesystem` cannot reach
`noBackupFilesDir`, so exclusion is done with rule files.

- [ ] `AndroidManifest.xml` references `@xml/data_extraction_rules` (API 31+) and `@xml/backup_rules` (API 23-30). Both exclude `flashydex/catalogs`, `flashydex/packs` and the cache domain (already in `apps/mobile/android/app/src/main/res/xml/`).
- [ ] Verify: `adb shell bmgr backupnow com.flashydex.app` / `adb shell dumpsys backup`, and a device-transfer test: user DB included, catalogs absent. List files with `adb shell run-as com.flashydex.app ls -R files/flashydex`.
- [ ] Decide whether to move catalogs to `noBackupFilesDir` (needs a native bridge) or keep rule-based exclusion.
- [ ] Repeat section 4 on a real device (createNCConnection on an externally written file, same-directory rename, force-kill recovery, low storage).
- [ ] Release build: R8/ProGuard does not strip the SQLite plugin.

Do not expect an iOS build on Windows; `ios/` and `android/` are committed for source control and Mac handoff only.
