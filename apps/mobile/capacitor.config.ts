import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.flashydex.app',
  appName: 'FlashyDex',
  webDir: 'dist',
  server: { androidScheme: 'https', iosScheme: 'capacitor' },
  ios: { contentInset: 'always' },
  plugins: {
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      electronIsEncryption: false,
      electronWindowsLocation: '',
      electronMacLocation: ''
    }
  }
};

export default config;
