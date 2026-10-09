import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
const output = resolve(process.env.STUDIO_INTEGRATION_OUTPUT || '../output/studio-code-mode-20261002/web/integration');
process.env.STUDIO_EVIDENCE_DIR = resolve(output, 'screenshots');
process.env.STUDIO_REQUIRE_PUBLIC_DEMO = '1';
export default defineConfig({ testDir: './tests', testMatch: ['studio-code-e2e.spec.ts', 'studio-access-ui.spec.ts', 'studio-director-ui.spec.ts', 'studio-parts-ui.spec.ts', 'studio-director-edgecases.spec.ts', 'studio-camera-ui.spec.ts', 'studio-ai-capture.spec.ts', 'studio-canvas-placement.spec.ts'], timeout: 120_000, workers: 1, retries: 0,
  outputDir: resolve(output, 'browser'), reporter: [['list'], ['json', { outputFile: resolve(output, 'browser-results.json') }]],
  use: { channel: 'chrome', baseURL: process.env.STUDIO_TEST_BASE_URL || 'http://127.0.0.1:18365', viewport: { width: 1600, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
