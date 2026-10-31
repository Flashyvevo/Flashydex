import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.flashydex.app',
  appName: 'FlashyDex',
  webDir: 'dist',
  backgroundColor: '#0b0d12',
  server: { androidScheme: 'https', iosScheme: 'capacitor' },
  // Edge-to-edge: the web layer owns safe-area padding (env(safe-area-inset-*)) — DESIGN-TOKENS §5.2.
  ios: { contentInset: 'never', backgroundColor: '#0b0d12' },
  android: { adjustMarginsForEdgeToEdge: 'force', backgroundColor: '#0b0d12' },
  plugins: {
    // Splash stays up until the first route has painted; the app hides it (src/lib/native.ts).
    SplashScreen: { launchAutoHide: false, backgroundColor: '#0b0d12' },
    // iosDatabaseLocation is intentionally NOT set: the plugin flags a custom location directory with
    // isExcludedFromBackup, which would drop flashydex-user.db from device backup (Director ruling S7).
    // The default (Documents) is backed up and is not user-visible while UIFileSharingEnabled is unset.
    // Catalog DBs are NOT plugin-managed on native: pack-install writes them under Library/NoCloud
    // (flagged isExcludedFromBackup by the Filesystem plugin) and opens them read-only (createNCConnection).
    CapacitorSQLite: {
      electronIsEncryption: false,
      electronWindowsLocation: '',
      electronMacLocation: ''
    }
  }
};

export default config;
