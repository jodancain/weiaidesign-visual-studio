import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const output = fileURLToPath(new URL('../../output/image2-professional-20261013/phase-a/', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: 'image2-vector-parity.spec.ts', timeout: 180000, workers: 1,
  outputDir: `${output}/playwright`, reporter: [['list'], ['json', { outputFile: `${output}/playwright-results.json` }]],
  use: { baseURL: 'http://127.0.0.1:18109', headless: true, viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
