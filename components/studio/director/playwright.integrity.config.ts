import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
const out = resolve(process.cwd(), process.env.STUDIO_EVIDENCE_DIR || '../output/studio-v3-integrity-20261001/web/regression');
export default defineConfig({ testDir: '../../../tests', testMatch: ['studio-director-ui.spec.ts', 'studio-parts-ui.spec.ts', 'studio-director-edgecases.spec.ts'], timeout: 120_000, workers: 1, outputDir: resolve(out, 'playwright'), reporter: [['list'], ['json', { outputFile: resolve(out, 'playwright-results.json') }]], use: { channel: 'chrome', baseURL: process.env.STUDIO_TEST_BASE_URL || 'http://127.0.0.1:18293', viewport: { width: 1600, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' } });
