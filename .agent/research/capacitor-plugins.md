# Capacitor plugins — versions and platform notes

Fetched 2026-10-31 from the npm registry, GitHub tags, plugin READMEs, and Drizzle's sqlite-proxy source. Versions below are what those endpoints returned that day. Pin them in the lockfile; do not treat "latest" as stable across weeks.

The brief locks Capacitor 7. npm `dist-tags` for `@capacitor/core` on this date:

- `latest-7`: 7.6.10
- `latest`: 8.6.0
- `next`: 9.0.0-beta.0

Same `latest` / `latest-7` split on `@capacitor/cli`, `@capacitor/ios`, and `@capacitor/android`. `@capacitor/cli@8.6.0` declares `engines.node >= 22`. The 7.6.10 package metadata was not opened for an engines field. The brief already requires Node 22 or newer.

If the build stays on Capacitor 7, use the `latest-7` column. The `latest` column is Capacitor 8 and will not satisfy a `>=7 <8` peer. This note does not argue for moving off 7. It records that 7 is no longer current.

## Version table

| Package | Capacitor 7 line | npm latest | Peer on the package checked |
| --- | --- | --- | --- |
| `@capacitor/core` | 7.6.10 (`latest-7`) | 8.6.0 | — |
| `@capacitor/cli` | 7.6.10 | 8.6.0 | — |
| `@capacitor/ios` | 7.6.10 | 8.6.0 | `^8.6.0` on 8.6.0 |
| `@capacitor/android` | 7.6.10 | 8.6.0 | `^8.6.0` on 8.6.0 |
| `@capacitor-community/sqlite` | 7.0.3 (newest 7.x tag) | 8.1.1 | `>=7.0.0` on 7.0.3; `>=8.0.0` on 8.1.1 |
| `jeep-sqlite` | no major split in dist-tags | 2.8.0 | sqlite 7.0.3 and 8.1.1 both depend on `jeep-sqlite ^2.7.2` |
| `sql.js` | — | 1.15.2 | jeep-sqlite 2.8.0 depends on `sql.js ^1.11.0` |
| `@capacitor/filesystem` | 7.1.9 | 8.1.5 | `>=8.0.0` on 8.1.5 |
| `@capacitor/share` | 7.0.4 | 8.0.3 | `>=8.0.0` on 8.0.3 |
| `@capacitor/haptics` | 7.0.5 | 8.0.2 | `>=8.0.0` on 8.0.2 |
| `@capacitor/camera` | 7.0.5 (Phase 3) | 8.2.6 | `>=8.0.0` on 8.2.6 |
| `@capacitor/preferences` | 7.0.4 | 8.0.1 | `>=8.0.0` on 8.0.1 |
| `@capacitor/status-bar` | 7.0.6 | 8.0.4 | `>=8.0.0` on 8.0.4 |
| `@capacitor/splash-screen` | 7.0.5 | 8.0.2 | `>=8.0.0` on 8.0.2 |
| `@capacitor/app` | 7.1.2 | 8.1.2 | `>=8.0.0` on 8.1.2 |

Sources: `https://registry.npmjs.org/-/package/<name>/dist-tags` and `https://registry.npmjs.org/<name>/<version>` for sqlite 7.0.3 and 8.1.1. GitHub tags `https://api.github.com/repos/capacitor-community/sqlite/tags?per_page=40` listed `v7.0.3` as the newest 7.x tag, then `v8.0.0`.

Platform support below is from the sqlite README's method table (master, fetched the same day) and from each official plugin README at the 7.x version. I did not install the packages or compile an iOS/Android project.

## `@capacitor-community/sqlite`

README: https://raw.githubusercontent.com/capacitor-community/sqlite/master/README.md
API: https://raw.githubusercontent.com/capacitor-community/sqlite/master/docs/API.md

iOS, Android, and web are all marked supported for the methods Phase 1 needs: `open` of a non-encrypted database, `execute`, `run`, `query`, `beginTransaction` / `commitTransaction` / `rollbackTransaction`. Encrypted `open` is supported on iOS, Android, and Electron, and not on web.

### Web: jeep-sqlite and sql.js

The README install block for pnpm tells you to install `jeep-sqlite` and `sql.js` as well as the plugin. Web databases are "backed by jeep-sqlite and stored in IndexedDB." I did not find OPFS in that README. The brief's "OPFS/IndexedDB" line is only half confirmed: IndexedDB yes, OPFS not in the page I fetched.

For Vue and React (this app is Vite + React), copy `sql-wasm.wasm` from `node_modules/sql.js/dist/sql-wasm.wasm` to `public/assets`. Angular copies it to `src/assets` instead. Missing that file is a blank web database, not a native bug.

`initWebStore` and `saveToStore` are web-only in the method table. Native code must not call them, or must no-op. The web store has to be initialized before the first open, and saved after writes if the plugin's web path requires an explicit save. Confirm against `docs/Web-Usage.md` when implementing; I fetched the API doc and the README, not the Web-Usage page. That page is listed from the README and was not fetched. Marked incomplete in the report.

### Drizzle `sqlite-proxy`

Drizzle ORM 0.45.4 is current on npm. Its sqlite-proxy driver is `drizzle()` from `drizzle-orm/sqlite-proxy`. Source fetched: https://raw.githubusercontent.com/drizzle-team/drizzle-orm/main/drizzle-orm/src/sqlite-proxy/driver.ts

The callback Drizzle will call is:

```
(sql: string, params: any[], method: 'run' | 'all' | 'values' | 'get') => Promise<{ rows: any[] }>
```

There is an optional batch callback with the same shape. The driver does not know about Capacitor. The adapter in `packages/core` has to map `method` onto the plugin:

- Plugin API doc: DDL (`CREATE`, `ALTER`, `DROP`) uses `execute`. Transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`) uses `execute`. `PRAGMA` uses `execute`.
- DML with bind values (`INSERT`, `UPDATE`, `DELETE`, `REPLACE`) uses `run`. DML without binds may use either `execute` or `run`.
- `SELECT` uses `query`.

If the adapter sends a `BEGIN` through `run` because Drizzle labeled the call `run`, that violates the plugin's own rule. Route on the SQL verb, not only on Drizzle's method name. Drizzle's `all` / `values` / `get` are reads and map to `query`. Drizzle's `run` is the write path and maps to `run` only when the statement is bound DML.

`execute` is "a batch of raw statements as a string" and does not take the bind-value array that `run` takes. Do not pass binds to `execute`.

### RETURNING

The plugin's `Changes` type includes `values`, described as "values when RETURNING", and `lastId`, "the lastId created from a run command." So the current API doc claims RETURNING results come back on that object. I did not execute a RETURNING statement against the plugin. Drizzle's callback must return `{ rows }`. If a Drizzle insert uses `RETURNING` and the adapter only returns `changes` / `lastId`, Drizzle will not see the row. The adapter should copy `changes.values` into `rows` when it is present. That is an integration requirement read off the two APIs, not a tested failure.

### Transactions

Two mechanisms, both marked supported on iOS, Android, and web:

- SQL `BEGIN` / `COMMIT` / `ROLLBACK`, which the API doc says must go through `execute` (since the plugin existed; the doc does not give a version for that rule).
- `beginTransaction` / `commitTransaction` / `rollbackTransaction` / `isTransactionActive`, "since 5.0.7", so present on 7.0.3.

Drizzle will emit SQL transaction statements through the proxy callback. Use the SQL path, via `execute`, unless a test shows the plugin ignores `BEGIN` inside `execute`. Do not mix the SQL path and the method path in one transaction.

### Encryption flag

`capacitor.config` example in the README sets `iosIsEncryption`, `androidIsEncryption`, and `electronIsEncryption` to `true`, plus keychain and biometric blocks. Those flags are build configuration, not a per-call argument. Phase 1 should leave encryption off unless the owner asks for it. Web cannot open an encrypted database (method table).

The same README says the plugin links SQLCipher even for unencrypted databases, and points at Apple's export rules and a possible year-end self-classification report. That is a compliance item, written up in `docs/APP-STORE-COMPLIANCE.md`. Do not set `ITSAppUsesNonExemptEncryption` from this file.

### iOS file location and backup

API doc, iOS section:

- Default: "in the Documents folder of YOUR_APPLICATION".
- Or the folder in `capacitor.config.ts`, "since 3.3.3-2". The doc says: "In that case the databases will not be not visible to iTunes and not backed up to iCloud." The example value is `iosDatabaseLocation: "Library/CapacitorDatabase"`.

Use `Library/CapacitorDatabase` so a collection is not silently copied into iCloud Backup. The double negative is theirs; the intent of the sentence is exclusion from iTunes visibility and iCloud backup. I did not read the native source to confirm the `NSURLIsExcludedFromBackupKey` call. The published doc is the contract until someone reads the Swift.

The plugin rewrites the database name: it adds the suffix `SQLite` and the extension `.db`, and it strips a `.db` you already passed. `flashydex` becomes `flashydexSQLite.db`. `flashydex.db` becomes the same. The brief's filename `flashydex.db` will not be the on-disk name if this plugin is the writer. Core should store the logical name and not assume the file is literally `flashydex.db`. Export/import talks about user files, not this internal file.

### Android note that will bite Play submission

The README's Android quirk example sets `targetSdkVersion = 35`. Google Play, as of 31 August 2026, requires API 36 for new apps and updates. See the compliance doc. Do not copy 35 out of the plugin README.

`minSdkVersion = 23` in that example. Not re-verified against Capacitor 7's own minimum.

## `@capacitor/filesystem` 7.1.9

README: https://unpkg.com/@capacitor/filesystem@7.1.9/README.md

iOS, Android, and web. Phase 1 export can write a file and hand it to the share sheet. It does not need the Files app.

Xcode / plist, only if files must show up in Files:

- `UIFileSharingEnabled` = YES
- `LSSupportsOpeningDocumentsInPlace` = YES

Do not set those for the SQLite file. The collection database should stay in `Library/CapacitorDatabase`, not in Documents, so these keys would not expose it anyway. Leave them unset in Phase 1.

Android: `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` are for `Directory.Documents` or `Directory.ExternalStorage` on Android 10 and older. `Directory.ExternalStorage` is "only available on Android 9 or older." `Directory.Documents` on Android 11+ only sees files the app created. Prefer `Directory.Cache` or `Directory.Data` for an export temp file, then share it. Do not add external-storage permissions.

## `@capacitor/share` 7.0.4

README: https://unpkg.com/@capacitor/share@7.0.4/README.md

No iOS usage-description key in that README. Use this for CSV/JSON export. It is the native share sheet, which is the 4.2 "not a website" argument and the 5.1.1(iii) preference for a share sheet over broad photo/file access.

Android, quoted from that README: "By default, Capacitor apps only allow to share files from caches folder. To make other Android folders shareable, they have to be added in `android/app/src/main/res/xml/file_paths.xml`." Write the export temp file into `Directory.Cache` and share that URI. Do not point the share sheet at the SQLite file.

## `@capacitor/haptics` 7.0.5

README: https://unpkg.com/@capacitor/haptics@7.0.5/README.md

No Info.plist key in a search of that file. iOS and Android. Web is a no-op or a vibration API depending on the browser; don't depend on it for a function, only for feedback. Use a light impact on add-card success. No Xcode capability.

## `@capacitor/camera` 7.0.5 — Phase 3, not Phase 1

README: https://unpkg.com/@capacitor/camera@7.0.5/README.md

Do not add this dependency in the Phase 1 app. Linking it forces the usage strings and puts a camera API in the binary a reviewer can ask about.

When Phase 3 adds it, iOS Info.plist must contain:

- `NSCameraUsageDescription`
- `NSPhotoLibraryAddUsageDescription`
- `NSPhotoLibraryUsageDescription`

The README lists all three. Apple's own key docs say the add-only key replaces the read/write key if the app never reads the library. Prefer the system camera plus the photo picker, and omit `NSPhotoLibraryAddUsageDescription` unless we save images back to Photos. If the plugin's iOS code references the add key even when we don't save, the string has to be present or the app crashes on that path. Check the plugin's iOS sources at implementation time. Not verified here.

Android: the README says picking an existing image uses the Android Photo Picker on Android 11+ with a Play services backport prompt for older devices. That matches Play's rule against `READ_MEDIA_IMAGES` when a picker is enough. Do not add that permission.

Draft purpose-string text is in `docs/APP-STORE-COMPLIANCE.md`.

## `@capacitor/preferences` 7.0.4

README fetched: https://unpkg.com/@capacitor/preferences@7.0.4/README.md

Small key-value store. On iOS this is UserDefaults. UserDefaults is a required-reason API category in Apple's privacy manifest. The app or the plugin must declare the reason in `PrivacyInfo.xcprivacy`. I did not open the plugin's privacy manifest. First Xcode archive privacy report is the check. Use Preferences for flags (theme, last sync language), not for the collection.

No usage-string. No Xcode capability.

## `@capacitor/status-bar` 7.0.6

README: https://unpkg.com/@capacitor/status-bar@7.0.6/README.md

Xcode-side, required: `UIViewControllerBasedStatusBarAppearance` = YES in Info.plist. Optional defaults: `UIStatusBarHidden`, `UIStatusBarStyle`.

The app draws its own dark bar content. Set style to light content on the dark theme, and respect the safe area. Don't hide the status bar; 2.5.9 rejects apps that disable standard switches, and a hidden status bar is a review nit even when the guideline doesn't name it. I am not citing 2.5.9 as a ban on hiding the status bar. Just don't hide it.

## `@capacitor/splash-screen` 7.0.5

README: https://unpkg.com/@capacitor/splash-screen@7.0.5/README.md

Call `SplashScreen.hide()` when the first real screen is ready, or the splash sits on top of a loaded app.

Android: Capacitor 4 and later use the Android 12 SplashScreen API plus `androidx.core:core-splashscreen`. The launch theme parent is `Theme.SplashScreen` unless you opt out in `android/app/src/main/res/values/styles.xml`. Android 12 has known launcher bugs the README points at Google's issue tracker; Android 13 fixed them and did not backport. Not our bug to patch.

iOS splash is the launch storyboard `cap sync` generates. The 7.0.5 README's opening does not add an Info.plist key beyond that. I did not read past the Android 12 section for an iOS key. If `cap add ios` emits `UILaunchStoryboardName`, leave it.

Splash artwork follows the same trademark rule as the icon: no Pokémon character art.

## `@capacitor/app` 7.1.2

README fetched: https://unpkg.com/@capacitor/app@7.1.2/README.md

App state, back button, URL open, app info. No usage string for the state listener. The README says a custom URL scheme is registered by editing Info.plist. Phase 1 does not need a custom scheme. Don't add one.

Use `appStateChange` so a backgrounded sync can pause cleanly. Phase 1 sync is foreground-only; when the app backgrounds, stop issuing new TCGdex requests rather than declaring a background mode. Background modes are 2.5.4 and are out of Phase 1.

No Xcode capability for the basic listener. Universal links would need associated domains. We don't have a domain to claim. Don't add the entitlement.

## CapacitorHttp

Not a separate package. It is in `@capacitor/core`. Docs shipped inside 7.6.10: https://unpkg.com/@capacitor/core@7.6.10/http.md

`CapacitorHttp.enabled` defaults to false. When true, it patches `fetch` and `XMLHttpRequest` to use the native HTTP stack. You can also call `CapacitorHttp.get` / `request` directly without the patch.

The brief says TCGdex is called via `fetch` or CapacitorHttp, and CORS on the API is `*`. Web and the dev phone browser can use `fetch`. A WKWebView sometimes still needs the native stack for cookies or for requests the webview blocks. I did not reproduce a WKWebView CORS failure against TCGdex. Don't enable the global patch until a device shows `fetch` failing. A global patch changes every `fetch` in the app, including ones tests don't expect.

Native request bodies: "On Android and iOS, data can only be a string or a JSON" unless the patch is on and the caller uses `fetch`. Catalog sync is GET, so this doesn't matter for Phase 1. Import-from-URL would.

No Info.plist key for HTTP. ATS allows HTTPS by default. Don't add an ATS exception for cleartext.

## Xcode-side config, collected

Required when the plugin is in the binary:

- status-bar: `UIViewControllerBasedStatusBarAppearance` = YES
- camera (Phase 3 only): the three usage strings, or fewer if the iOS sources allow it
- sqlite: `iosDatabaseLocation` in `capacitor.config.ts`, not in Info.plist. Encryption flags in the same config if, and only if, encryption is on
- splash: launch storyboard from `cap sync`; Android launch theme parent

Not required for Phase 1, and should stay off:

- `UIFileSharingEnabled`
- `NSCameraUsageDescription` and the photo keys, until the camera plugin is linked
- Associated Domains
- background modes

`ITSAppUsesNonExemptEncryption` is an app key, not a plugin key. See the compliance doc. SQLCipher being linked is why it cannot be set blindly.

## `onnxruntime-web` in WKWebView — facts only, Phase 2

Package: `onnxruntime-web` 1.31.1 (`latest` on 2026-10-31). A `dev` tag `1.32.0-dev.20261030-b5fe413d0` also existed. Not a Phase 1 dependency.

Docs fetched:

- https://onnxruntime.ai/docs/get-started/with-javascript/web.html
- https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html

Compatibility table on the get-started page, columns in order: Chrome/Edge Windows, Chrome/Edge Android, Chrome/Edge macOS, Chrome/Edge iOS, Safari macOS, Safari iOS, Firefox Windows, Node.js.

- WebAssembly (CPU): supported in every one of those columns, including Safari (iOS). Footnote: Node.js is single-threaded wasm only.
- WebGPU: supported on the first three (Chrome/Edge on Windows, Android, macOS). Not supported on Chrome/Edge iOS, Safari macOS, Safari iOS, Firefox, or Node. Footnotes: WebGPU needs Chromium 113+ on Windows, Float16 needs newer Chrome/Edge; Android needs Chromium 121+.
- WebGL: supported on the browser columns, including Safari iOS, not on Node. "WebGL support is in maintenance mode. It is recommended to use WebGPU for better performance."

The WebGPU tutorial says WebGPU "is also available in Firefox behind a flag and Safari Technology Preview." That is not shipping Safari, and it is not the compatibility table's Safari (iOS) cell, which is a no.

WKWebView is not named on either page. I will not invent a WKWebView-specific bug. What the table supports saying: a Capacitor iOS app runs web JS in WebKit, and ONNX Runtime Web's own table marks WebGPU unsupported on Safari iOS and WASM supported on Safari iOS. Phase 2 planning should assume the WASM execution provider inside the webview until someone runs the session on a device and records the result. WebGPU-on-iOS is not a plan that these pages back.

Model download versus Guideline 2.5.2 is in the compliance doc. The interpreter has to ship in the reviewed binary. The weight file is the thing Apple's Core ML download page treats as downloadable, by analogy, not by an ONNX-specific sentence.
