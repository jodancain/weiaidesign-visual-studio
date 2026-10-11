import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: 'image2-integration.spec.ts', timeout: 180000, workers: 1,
  outputDir: '/tmp/image2-real-browser-results',
  use: { baseURL: 'http://127.0.0.1:18109', headless: true, launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node tests/image2-integration-server.mjs', cwd, url: 'http://127.0.0.1:18108/health', reuseExistingServer: false, timeout: 30000 },
    { command: 'npm run dev -- --hostname 127.0.0.1 --port 18109', cwd, url: 'http://127.0.0.1:18109/image2', reuseExistingServer: false, timeout: 120000,
      env: { IMAGE2_API_URL: 'http://127.0.0.1:18108', IMAGE2_API_TOKEN: 'image2-local-browser-test-token-20261010', STUDIO_VISITOR_SECRET: 'local-image2-browser-visitor-secret-not-production', IMAGE_OPENAI_BASE_URL: '', IMAGE_OPENAI_API_KEY: '', OPENAI_API_KEY: '', AGENT_LLM_BASE_URL: '', AGENT_LLM_API_KEY: '', GPU_COMFY_BASE_URL: '', GPU_COMFY_TOKEN: '', IMAGE2_OCR_URL: '', IMAGE2_OCR_TOKEN: '' } },
  ],
});
