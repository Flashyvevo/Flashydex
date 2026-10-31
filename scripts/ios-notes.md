# iOS handoff notes

iOS builds require a Mac. Install the current Xcode release supported by Capacitor 7, then select its command-line tools:

```bash
xcode-select --install
npm install
npm run build
npm run cap:sync
npx cap open ios
```

In Xcode:

1. Select the `App` target and set a unique bundle identifier if `com.flashydex.app` is not final.
2. Choose the owner’s Apple Developer signing team and enable automatic signing.
3. Set deployment target and device families to the App Store release requirements.
4. Confirm `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` are reviewer-ready before implementing camera or photo import.
5. If CocoaPods asks for it, close Xcode and run `pod install` from `apps/mobile/ios/App`, then reopen `App.xcworkspace`.
6. Complete App Store export-compliance as “no custom encryption” unless that changes.

Do not expect an iOS build on Windows; native projects are generated here only for source control and Mac handoff.
