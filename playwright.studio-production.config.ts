import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
if (process.env.STUDIO_PRODUCTION_QA !== '1') throw new Error('Set STUDIO_PRODUCTION_QA=1 only after the release owner opens production acceptance.');
if (!process.env.STUDIO_EXPECTED_BUILD_ID) throw new Error('The exact deployed BUILD_ID is required.');
const output = resolve(process.env.STUDIO_PRODUCTION_OUTPUT || '../output/studio-code-mode-20261002/web/production-final');
process.env.STUDIO_EVIDENCE_DIR = resolve(output, 'screenshots');
process.env.STUDIO_REQUIRE_PUBLIC_DEMO = '1';
export default defineConfig({ testDir: './tests', testMatch: ['studio-access-ui.spec.ts', 'studio-director-ui.spec.ts', 'studio-parts-ui.spec.ts', 'studio-director-edgecases.spec.ts', 'studio-camera-ui.spec.ts', 'studio-ai-capture.spec.ts', 'studio-canvas-placement.spec.ts', 'studio-production-surface.spec.ts'], timeout: 120_000, workers: 1, retries: 0,
  outputDir: resolve(output, 'browser'), reporter: [['list'], ['json', { outputFile: resolve(output, 'browser-results.json') }]],
  // Traces may contain the full signed visitor cookie. Keep failure screenshots
  // and metadata-only evidence instead of persisting access credentials.
  use: { channel: 'chrome', baseURL: 'https://weiaidesign.com', viewport: { width: 1600, height: 1000 }, screenshot: 'only-on-failure', trace: 'off' },
});
