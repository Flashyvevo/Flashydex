import { defineConfig } from '@playwright/test';

// The owner's dev server on :3200 may be the HTTPS one (`npm run dev:https`) and must never be touched.
// E2E therefore owns a plain-http Vite on :3201 (127.0.0.1 is a secure context, so Web Locks work).
// `FLASHYDEX_E2E_BASE_URL` points the suite at an already-running server instead (no webServer, TLS errors ignored).
const externalBase = process.env.FLASHYDEX_E2E_BASE_URL;
const E2E_PORT = 3201;
const baseURL = externalBase ?? `http://127.0.0.1:${E2E_PORT}`;

// Strip the HTTPS switch so an exported FLASHYDEX_DEV_HTTPS=1 can't turn the managed server into TLS.
const serverEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'FLASHYDEX_DEV_HTTPS') serverEnv[k] = v;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    browserName: 'chromium',
    ...(externalBase ? { ignoreHTTPSErrors: true } : {})
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
  webServer: externalBase
    ? undefined
    : {
        command: `npx vite --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
        url: baseURL,
        reuseExistingServer: false,
        timeout: 60_000,
        env: serverEnv
      }
});
