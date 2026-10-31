import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3200',
    browserName: 'chromium'
  },
  projects: [
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }
    },
    {
      name: 'desktop',
      use: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
      // The pack-install harness is viewport-independent; run it once (mobile project).
      testIgnore: /pack-install\.spec\.ts/
    }
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3200',
    reuseExistingServer: true,
    timeout: 60_000
  }
});
