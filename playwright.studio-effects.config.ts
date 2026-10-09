import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
const output = resolve(process.env.STUDIO_EFFECTS_OUTPUT || '../output/studio-effects-20261008/web');
export default defineConfig({
  testDir: './tests', testMatch: ['studio-effects-ui.spec.ts', 'studio-pipeline-ui.spec.ts'], timeout: 90_000, workers: 1, retries: 0,
  outputDir: resolve(output, 'browser'), reporter: [['list'], ['json', { outputFile: resolve(output, 'browser-results.json') }]],
  use: { channel: 'chrome', baseURL: process.env.STUDIO_TEST_BASE_URL || 'http://127.0.0.1:18393', viewport: { width: 1600, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
