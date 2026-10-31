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

## 6. Native writable catalog (R04) — required before `catalogWrites` can be true

Source-proven defect (Stage D review R04): `createNCConnection` returns a read-only `SQLiteDBConnection`, so price refresh could never write through it.
The chosen design (documented in `apps/mobile/src/platform/pack-install/native-store.ts`, flag `NATIVE_CATALOG_WRITES = false`,
`// TODO(R04-mac)` also in `platform/app-database.ts`) copies the active catalog into the plugin's writable databases directory, opens it with
`createConnection`, and writes the result back over the active file by same-volume rename. NOTHING of this runs until these steps pass on a Mac and an Android device:

1. [ ] iOS: confirm the plugin writable DB directory (`Library/CapacitorDatabase`). `Filesystem.copy` an installed `catalog-en.db` to
       `Library/CapacitorDatabase/catalog-en-rwSQLite.db` (Directory.Library + `CapacitorDatabase/...`).
2. [ ] `createConnection('catalog-en-rw', false, 'no-encryption', 1, false)` then `open()`; `SELECT COUNT(*) FROM catalog_cards` equals the manifest count.
3. [ ] `execute` an `UPDATE catalog_latest_prices ...` inside `BEGIN IMMEDIATE`/`COMMIT` through the sqlite-proxy callback (the same code path `SyncService` uses) and read it back.
4. [ ] `closeConnection`, then confirm the WAL/journal is checkpointed (no `-wal` file or its content is merged) and the file reopens with the update present.
5. [ ] Copy the rw file to `Library/NoCloud/flashydex/catalogs/catalog-en-<writeback>.db.part` and run `activate` (previous kept). Reopen with `createNCConnection`; the update is visible.
6. [ ] Kill the app between 3 and 5: on relaunch the ACTIVE catalog is either entirely old or entirely new (never a mix), and the rw copy is deleted on boot.
7. [ ] Backup exclusion: the rw copy in `Library/CapacitorDatabase` IS backed up by default; confirm it is deleted after step 5 (and on boot), or flag it excluded with `isExcludedFromBackup`.
8. [ ] Android: the plugin `databases/` directory is not reachable through `@capacitor/filesystem`. Decide: a plugin-provided copy API/custom native method, or keep native writes
       disabled on Android. Repeat steps 2-6 with whichever path is chosen.
9. [ ] Only then set `NATIVE_CATALOG_WRITES = true`, rebuild, and check prices_only/refresh/incremental enable (`sync.capabilities()` true) and a real price update persists after force-quit.

## 7. Privacy manifest (R13) — needs archive audit on Mac

`apps/mobile/ios/App/App/PrivacyInfo.xcprivacy` is app-owned and declares only what the app source verifiably uses:
file timestamps via `Filesystem.stat` on files inside the app container (reason `C617.1`). Not declared because not used in app code: UserDefaults (no
`@capacitor/preferences`; Capacitor core's own manifest covers its use), disk-space APIs (free-space preflight is not implemented on native), system boot time.

- [ ] Add `PrivacyInfo.xcprivacy` to the **App target** in Xcode (File -> Add Files, tick the App target; the project file was not hand-edited on Windows).
- [ ] Product -> Archive, then Organizer -> Distribute -> Generate Privacy Report. Compare the merged report with this manifest and with each pod's own manifest
      (Capacitor, CapacitorCommunitySqlite/SQLCipher, Filesystem, Share, Haptics, etc.); add any required-reason API the report lists (and remove any we do not use).
- [ ] Do NOT change `ITSAppUsesNonExemptEncryption` here: that is the owner's export-compliance review (section 2).
- [ ] Native metadata HTTP still uses `fetch` rather than an explicit CapacitorHttp path (R13 remaining item); manifest/pack streaming over `fetch` works in WKWebView but the
      CapacitorHttp injection test (offline, redirect, TLS failure, large body) has not been written.
