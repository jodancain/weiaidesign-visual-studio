import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
const output = resolve(process.cwd(), process.env.STUDIO_LOOP_OUTPUT || '../output/studio-v3-qa-loop-20261001');
process.env.STUDIO_EVIDENCE_DIR ||= resolve(output, 'screenshots');
mkdirSync(process.env.STUDIO_EVIDENCE_DIR, { recursive: true });
export default defineConfig({
  testDir: './tests', testMatch: process.env.STUDIO_LOOP_FULL === '1' ? ['studio-loop-ui.spec.ts', 'studio-ui.spec.ts', 'studio-director-ui.spec.ts', 'studio-parts-ui.spec.ts', 'studio-director-edgecases.spec.ts', 'studio-access-ui.spec.ts', 'studio-camera-ui.spec.ts', 'studio-canvas-placement.spec.ts', 'studio-ai-capture.spec.ts'] : 'studio-loop-ui.spec.ts', timeout: 120_000, workers: 1, retries: 0,
  outputDir: resolve(output, 'browser'),
  reporter: [['list'], ['json', { outputFile: resolve(output, process.env.STUDIO_LOOP_REPORT || 'browser-results.json') }]],
  use: { channel: 'chrome', baseURL: process.env.STUDIO_TEST_BASE_URL || 'http://127.0.0.1:18294', viewport: { width: 1600, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
