import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'image2-legacy-binding.spec.ts', workers: 1, timeout: 60_000,
  outputDir: process.env.IMAGE2_BROWSER_EVIDENCE_DIR || '../output/image2-binding-browser',
  reporter: [['list']],
  use: { baseURL: process.env.IMAGE2_BINDING_TEST_URL || 'http://127.0.0.1:18241', channel: 'chrome', viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
