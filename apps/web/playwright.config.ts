import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  use: {
    browserName: "chromium",
    viewport: { width: 390, height: 844 },
    baseURL: "http://127.0.0.1:3200",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3200",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
