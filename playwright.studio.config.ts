import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'studio-ui.spec.ts', timeout: 90_000, workers: 1,
  outputDir: '../output/studio-v3-validation-20261001/playwright',
  reporter: [['list'], ['json', { outputFile: '../output/studio-v3-validation-20261001/playwright-results.json' }]],
  use: { channel: 'chrome', baseURL: process.env.STUDIO_TEST_BASE_URL || 'http://127.0.0.1:18293', viewport: { width: 1600, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
