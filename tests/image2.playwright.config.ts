import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'image2-ui.spec.ts', timeout: 45000, workers: 1,
  use: { baseURL: process.env.IMAGE2_TEST_BASE_URL || 'http://127.0.0.1:3218', headless: true, launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined } },
  webServer: process.env.IMAGE2_TEST_BASE_URL ? undefined : { command: 'npm run dev -- --hostname 127.0.0.1 --port 3218', url: 'http://127.0.0.1:3218/image2', reuseExistingServer: true, timeout: 120000 },
});
