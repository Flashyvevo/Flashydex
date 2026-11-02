# iOS camera, HEIC, OPFS, and tunnel notes for FlashyDex

Researched 2026-10-31 from WebKit, MDN browser-compat-data, caniuse, and Apple support. Items marked UNVERIFIED were not confirmed on a device or in a release note.

## 1. Does `capture="environment"` open the camera?

On iOS Safari the `capture` attribute has been supported since iOS 10. Desktop Safari does not implement it. `environment` means the outward-facing camera. Source: MDN browser-compat-data `html.elements.input.capture` (safari `false`, safari_ios `"10"`), spec https://w3c.github.io/html-media-capture/#dfn-capture, MDN https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture.

Expected behavior in a Safari tab: `<input type="file" accept="image/*" capture="environment">` opens the rear camera UI directly and does not offer the library. Without `capture`, iOS shows the sheet (Photo Library / Take Photo / Choose File). The spec calls `capture` a hint, so this is observed iOS behavior, not a guarantee a future release must keep. UNVERIFIED on iOS 17/18/26 specifically; no removal is listed in current BCD.

Standalone (Home Screen) uses the same WebKit, so the attribute is not a separate code path. The historical failure was the camera UI, not the attribute. Bug 206219: in a standalone app the file-input camera went blank after the app was backgrounded; reload did not fix it; force-quit did. Reporters said it was fixed in iOS 13.4 beta 2 and confirmed gone on 13.5.1. https://bugs.webkit.org/show_bug.cgi?id=206219. No 2024–2026 regression of that file-input bug was found. UNVERIFIED that it stays fixed on 17/18/26.

What is still broken is `getUserMedia`, which FlashyDex should not use for capture:

- Bug 215884: in standalone, camera permission is revoked on hash change, and again after about 90 seconds even with no navigation. Safari tabs keep the grant. https://bugs.webkit.org/show_bug.cgi?id=215884
- Bug 282327: Home Screen `getUserMedia` shows the camera indicator then returns no stream. A  comment says this was still true on iOS 18.5, while the same page worked in the Safari tab. https://bugs.webkit.org/show_bug.cgi?id=282327
- STRICH's current KB says PWA camera permission is not persisted and points at those bugs. Their workaround (drop `apple-mobile-web-app-capable`, run in Safari) throws away standalone. https://kb.strich.io/article/29-camera-access-issues-in-ios-pwa and https://bugs.webkit.org/show_bug.cgi?id=252465

File-input capture uses the system camera UI. It should not show a page-level camera permission prompt, and it should not re-prompt each visit. That "prompt every time" behavior is the `getUserMedia` bug, not the file input. UNVERIFIED on 17/18/26.

A blank page after capture is a separate risk: iOS can jetsam the web content process while the camera UI is up, more so in standalone and if the page then decodes a multi-megapixel file on return. No open WebKit bug for that on iOS 17/18/26 was found. Treat it as a test, not a known current defect.

## 2. JPEG or HEIC, and does `accept` transcode?

Settings → Camera → Formats controls what the camera writes, not what Safari must hand the page. High Efficiency stores HEIF/HEIC. Most Compatible stores JPEG. It only affects photos taken after the switch. On iPhone 14 and later with iOS 17, standard HEIF is up to 24 MP; HEIF Max is up to 48 MP on Pro models; RAW 12 is up to 12 MP. https://support.apple.com/en-us/119916. Photo Mode can be set to 12 MP or 24 MP. https://support.apple.com/guide/iphone/change-advanced-camera-settings-iphb362b394e/ios

Safari then applies its own transcode on the photo-library picker:

- Before WebKit commit 0f76043 (2024-03-05), iOS transcoded photo-library images to JPEG unconditionally, and video to H.264. https://bugs.webkit.org/show_bug.cgi?id=267277 and https://github.com/WebKit/WebKit/commit/0f76043f78527099a8af73cff7e76c489fd79568
- After that commit, image transcode runs only if `accept` restricts the image types. An empty restriction, or a set that contains all image types, keeps the original. Sites that want JPEG are expected to say so in `accept`.
- Bug 270470 is still NEW: when iOS does transcode, it still transcodes to JPEG, not to whatever type is first in `accept`. https://bugs.webkit.org/show_bug.cgi?id=270470

So, on a build that includes 0f76043:

- `accept="image/*"` (and no extra explicit type): HEIC stays HEIC if the photo was HEIC. `file.type` should be `image/heic`. UNVERIFIED that `image/*` counts as "all image types" on iOS rather than a literal; the commit message says the picker skips transcode when the restricted set is empty or contains all image types.
- `accept="image/jpeg"` or `accept="image/jpeg,image/png"` (no `image/heic`): HEIC is transcoded to JPEG. `file.type` is `image/jpeg`.
- Do not add `image/heic` next to other types. Safari 17+ has treated an explicit type plus a wildcard as "convert everything to the first explicit type," including PNG/JPEG to HEIC, with names like `tempImage….heic`. https://developer.apple.com/forums/thread/743049 and bug 303803, fixed in WebKit on 2026-01-08 (commit 305283). https://bugs.webkit.org/show_bug.cgi?id=303803. The bug comments confirm macOS; iOS is UNVERIFIED. Avoid the pattern anyway.

Which iOS first shipped 0f76043 was not in a release note found here. The commit landed the evening of 2024-03-05, the same day iOS 17.4 shipped, so 17.4 and earlier should still be treated as "always JPEG." Confirm on 17.5, 18, and 26.

Filename is not the camera roll name when transcoded. Reports show an RFC 4122 UUID plus `.jpeg`, or `tempImage` plus the output extension. https://news.ycombinator.com/item?id=33048355. `file.type` can also be empty. Do not trust the extension alone.

Library vs camera vs Files: the WebKit change is written against the photo picker. Whether a `capture=` shot, or a file chosen in the Files app, skips that transcode is UNVERIFIED. Test both.

## 3. Decode, EXIF, OffscreenCanvas

HEIC display: iOS Safari 17.0 through 26.6 and 27.2 support the HEIF/HEIC image format. Before 17 the OS decoded HEIC but Safari did not. https://caniuse.com/heif (note: "Was supported natively in macOS/iOS, but was not supported in Safari."). Chrome and Firefox still do not.

So on iOS 17+ an `<img src=blobURL>` of a HEIC file should paint. `createImageBitmap(heicBlob)` uses the same decoder and is expected to succeed; no WebKit test of that exact call was found. UNVERIFIED. A library README claiming canvas HEIC decode on iOS 13+ conflicts with caniuse and should be ignored. https://github.com/crisp-oss/canvas-heic-to-jpeg

EXIF:

- `<img>` applies EXIF orientation. Bug 237895 uses that as the working case.
- `createImageBitmap()` from a Blob does not. The image draws sideways. Creating the bitmap from an already-loaded `HTMLImageElement` does apply orientation. https://bugs.webkit.org/show_bug.cgi?id=237895. Status was still NEW when this page was fetched (2026-10-31).
- MDN says `imageOrientation: "from-image"` is the default and means "honor EXIF." https://developer.mozilla.org/en-US/docs/Web/API/createImageBitmap. Passing it does not close bug 237895. Do not trust it on a blob until an iPhone test shows upright pixels.
- `drawImage` does not re-read EXIF. It draws the bitmap it was given. An `<img>` that already applied EXIF draws upright. A blob `ImageBitmap` may not.

`OffscreenCanvas.convertToBlob({type:"image/jpeg"})` is in Safari 16.4+ and iOS mirrors that (BCD `api.OffscreenCanvas.convertToBlob`). The 2d context on `OffscreenCanvas` is also 16.4+. `image/webp` as the encode type is not supported on Safari (BCD `option_type_parameter_webp` is `false`). Fall back to a detached `<canvas>` and `toBlob` only if `convertToBlob` throws.

## 4. Size and dimensions handed to the page

Sensor vs saved file are different. iPhone 15 main camera is a 48 MP sensor. https://support.apple.com/en-us/111831. iPhone 16 Fusion is 48 MP. https://support.apple.com/en-us/121032. The default saved still on iPhone 14 and later is standard HEIF up to 24 MP, not the full 48, unless the user picks HEIF Max. https://support.apple.com/en-us/119916. iPhone 13's main camera is the older 12 MP sensor; this pass did not re-open that spec page, so treat 13 and non-Pro 14 pixel sizes as owner-measured. UNVERIFIED.

Apple's own size comparison: a 12 MP ProRAW is about 25 MB and a 48 MP ProRAW about 75 MB, and ProRAW is 10 to 12 times larger than HEIF or JPEG. https://support.apple.com/en-us/119916. That implies roughly 2 MB for a 12 MP HEIF/JPEG and roughly 6–8 MB for a 48 MP HEIF, before any Safari transcode. A JPEG transcode can be larger than the HEIC. These are derived ratios, not measured `File.size` values.

No current WebKit or Apple note says Safari downscales the `File` before the page sees it on iOS 17/18/26. The old in-page "Small / Medium / Large / Actual Size" chooser is what users report as removed. https://discussions.apple.com/thread/256318079. The early-iOS "5 megapixel canvas / JPEG subsampled above 2 MP" limits are obsolete and must not be used for iPhone 13–16. A 2025 practitioner library claims `drawImage` silently no-ops above 4096×4096 on iOS Safari. https://github.com/Araluma/safe-image-decode. That is not an Apple spec. UNVERIFIED. Measure `naturalWidth` / `naturalHeight` on device. Usual mappings if the file is full-resolution: 12 MP is 4032×3024, 24 MP is 5712×4284, 48 MP is 8064×6048. UNVERIFIED against a Safari `File`.

## 5. OPFS, sahpool, quota, eviction

`navigator.storage.getDirectory()` and `FileSystemFileHandle.createSyncAccessHandle()` are in Safari 15.2+ and iOS mirrors that (BCD). `createSyncAccessHandle` is only legal in a dedicated worker, takes an exclusive lock, and the method itself is async. https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle. The `mode` option (`readwrite-unsafe`) is not implemented in Safari (BCD `version_added: false`). One handle at a time.

SQLite's tested baseline is later than BCD's "15.2":

- Practical OPFS is Safari 16.4+. https://sqlite.org/wasm/doc/trunk/persistence.md
- The nested-worker OPFS VFS is broken on Safari before 17 because `getDirectory()` threw `InvalidStateError` in a sub-worker. Bug 255458, RESOLVED FIXED 2023-04-18. https://bugs.webkit.org/show_bug.cgi?id=255458. SQLite still documents Safari &lt; 17 as incompatible with that VFS, and says `opfs-sahpool` works on 16.4+ without COOP/COEP. The other OPFS VFS needs `SharedArrayBuffer`, which needs COOP/COEP. https://sqlite.org/wasm/doc/trunk/persistence.md and the May 2026 PowerSync table https://powersync.com/blog/sqlite-persistence-on-the-web

Use `opfs-sahpool` for FlashyDex. Do not depend on COOP/COEP on the Netlify origin.

Eviction, tab vs Home Screen:

- ITP deletes script-writable storage after 7 days of Safari use with no interaction on the site. The published list is IndexedDB, LocalStorage, media keys, SessionStorage, and service worker registrations plus Cache Storage. Days of Safari use, not calendar days. A visit resets the clock. https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ and https://webkit.org/tracking-prevention/#7-day-cap-on-all-script-writeable-storage
- The first-party domain of a Home Screen web app is exempt from that cap, and its data is isolated from Safari. https://webkit.org/tracking-prevention/#home-screen-web-application-domain-exempt-from-itp. Isolation is by design: Home Screen apps do not share storage with the Safari tab. https://bugs.webkit.org/show_bug.cgi?id=181849
- OPFS is not named in that 7-day list (the list predates OPFS). The 2023 storage policy does cover "File System" and says eviction also happens under the ITP "no interaction" rule. https://webkit.org/blog/14403/updates-to-storage-policy/. Whether a Safari tab's OPFS is in the 7-day sweep is therefore likely but not explicit. UNVERIFIED. Do not treat tab OPFS as durable.

Quota, Safari 17+ (iOS 17, iPadOS 17, Sonoma): a browser origin may use up to 60% of disk, overall quota 80%. A standalone Home Screen web app gets the same quota as the browser, not the 15%/20% "other apps" quota. There is no guarantee the origin can fill that number; `QuotaExceededError` is still possible, and `estimate()` may lie a bit to reduce fingerprinting. `estimate()`, `persist()`, and `persisted()` are fully supported from Safari 17 (BCD lists `persist`/`persisted` from 15.2 and `estimate` from 17). WebKit grants `persist()` by heuristic, notably if the site is open as a Home Screen web app. It does not describe a user prompt. A `false` return in a tab is normal. https://webkit.org/blog/14403/updates-to-storage-policy/

Clearing the site's data deletes OPFS. https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system

## 6. `fetch` to `https://*.trycloudflare.com`

No WebKit bug or Apple note was found that special-cases `*.trycloudflare.com`, ITP-blocks a first-party `fetch` to it, or treats standalone differently from a tab. ITP's 7-day cap is about storage and script-set cookies, not about a CORS POST body. https://webkit.org/tracking-prevention/

What does bite iOS Safari, independent of the tunnel hostname:

- CORS failures are reported opaquely. A dropped connection, a body the proxy rejected, or mixed content has historically surfaced as "Origin is not allowed by Access-Control-Allow-Origin" even after a successful OPTIONS. https://stackoverflow.com/questions/50660529/ios-safari-xmlhttprequest-cannot-load-due-to-access-control-checks and https://stackoverflow.com/questions/50141697/false-cors-failure-only-in-ios-mobile-safari-when-uploading-images (the second is iOS 11; the misleading error is the pattern to retest, not proof it still happens).
- A multipart upload must be a `FormData` body. Do not set `Content-Type` yourself. A manual `multipart/form-data` header strips the boundary and can fail the preflight. https://community.cloudflare.com/t/cloudflare-images-direct-upload-cors-problem/368114
- `credentials: "include"` plus third-party cookie blocking will not carry cookies to the tunnel. Use `credentials: "omit"` and no cookie auth.
- iCloud Private Relay plus Cloudflare Turnstile is a known stall (Cloudflare community, still reported in 2024). https://community.cloudflare.com/t/challenges-cloudflare-com-is-not-very-compatible-with-icloud-private-relay-in-some-cases/517928. A raw trycloudflare URL is not Turnstile. Whether Private Relay resets tunnel connections is UNVERIFIED.
- Quick tunnels are ephemeral and not a production origin. That is a Cloudflare product limit, not an iOS bug.

## Implications for FlashyDex

Do:

- Capture with `<input type="file" accept="image/jpeg,image/png" capture="environment">` if the recognizer wants JPEG. A restricted `accept` that does not list HEIC is what makes iOS transcode (bug 267277, bug 270470).
- Keep a second input without `capture` for the library. Log `name`, `type`, `size`, and decoded width/height before assuming format.
- In the `change` handler, copy the `File` into a variable (or OPFS) before any decode or navigation. If iOS killed the process while the camera was up, this is the only signal you will get.
- For orientation, load an `<img>`, wait for `decode()`, then `drawImage`. Do not use `createImageBitmap(file)` as the orientation path while bug 237895 is open.
- Downscale to a long edge around 1600–2048 before upload or canvas export. Encode with `OffscreenCanvas.convertToBlob({type:"image/jpeg", quality})` on iOS 16.4+. Never request WebP from that API on Safari.
- Store the SQLite DB with `opfs-sahpool` in a dedicated worker. Call `navigator.storage.persist()` after the Home Screen launch and branch on the boolean.
- POST to the tunnel with `fetch(url, {method:"POST", body: formData, credentials:"omit"})`. Echo the page origin in `Access-Control-Allow-Origin`. Do not put Turnstile on that host.

Do not:

- Do not use `getUserMedia` for the scanner in standalone (bugs 282327 and 215884).
- Do not set `accept="image/*,image/heic"` or any list that names `image/heic` beside other types (bug 303803, Apple forums 743049).
- Do not trust `file.name` or a missing `file.type`.
- Do not assume Settings → Formats means the page received that format. `accept` can transcode after the fact.
- Do not draw a 24 MP or 48 MP bitmap to a full-size canvas on the main thread.
- Do not use the nested-worker OPFS VFS, and do not require COOP/COEP for the database.
- Do not expect data written in the Safari tab to exist in the Home Screen app (bug 181849).
- Do not treat a tab-only install as durable past 7 days of Safari use.
- Do not set `Content-Type` on a `FormData` upload, and do not send cookies to the tunnel.

## Owner test steps on iPhone

Record iOS version, Settings → Camera → Formats, and Photo Mode megapixels before each run. Do the whole list once in a Safari tab and once from the Home Screen icon after a force-quit.

1. Tap the capture input. Confirm the rear camera opens with no web permission prompt and no library sheet. Cancel, then capture a portrait card. Confirm the page did not reload and `change` fired.
2. Background the app for 15 seconds, reopen, capture again. Confirm the preview is not black and the page is not blank. Force-quit and repeat once.
3. On the same input, log `file.name`, `file.type`, `file.size`. Repeat with `accept="image/*"`, `accept="image/jpeg"`, and `accept="image/*,image/heic"`. Expect JPEG only for the restricted jpeg/png accept, on iOS that includes the March 2024 WebKit change.
4. Pick the same photo from the library (no `capture`) and from Files if it is offered. Compare type and name to the camera capture.
5. Show the file in an `<img>` and also via `createImageBitmap(file, {imageOrientation:"from-image"})` drawn to a canvas. Note which one is upright.
6. Log `naturalWidth` and `naturalHeight`. Confirm they match the Photo Mode megapixels and are not silently 2048 or 4096.
7. In the tab, call `persist()` and `estimate()`, write a marker row, then open the Home Screen app and confirm the marker is absent. Call `persist()` there and confirm it returns true.
8. POST the JPEG `FormData` to the current `*.trycloudflare.com` URL from both contexts, Private Relay on and off. Confirm the server sees the POST body, not only OPTIONS. A console CORS error with no POST in the tunnel log is a transport failure, not proof the ACAO header is wrong.
