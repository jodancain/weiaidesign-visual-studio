import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const output = fileURLToPath(new URL('../../output/image2-context-menu-20261012/', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: 'image2-context-menu.spec.ts', timeout: 60000, workers: 1,
  outputDir: `${output}/playwright`, reporter: [['list'], ['json', { outputFile: `${output}/playwright-results.json` }]],
  use: { baseURL: 'http://127.0.0.1:18109', headless: true, viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
