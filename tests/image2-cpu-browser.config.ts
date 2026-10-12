import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const output = fileURLToPath(new URL('../../output/image2-browser-nonai-20261012/', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: 'image2-cpu-browser.spec.ts', timeout: 120000, workers: 1,
  outputDir: `${output}/playwright`,
  reporter: [['list'], ['json', { outputFile: `${output}/playwright-results.json` }]],
  use: { baseURL: 'http://127.0.0.1:18109', headless: true, viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  // The root harness owns the shared CPU-only service and Next server. Never restart them here.
});
