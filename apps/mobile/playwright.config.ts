import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:3200',
    browserName: 'chromium',
    viewport: { width: 390, height: 844 }
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3200',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
