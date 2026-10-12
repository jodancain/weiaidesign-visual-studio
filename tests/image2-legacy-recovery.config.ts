import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const output=resolve(process.env.IMAGE2_BROWSER_EVIDENCE_DIR || fileURLToPath(new URL('../../output/image2-original-recovery-20261012/',import.meta.url)));
export default defineConfig({
  testDir:'.',testMatch:'image2-legacy-recovery.spec.ts',timeout:90000,workers:1,
  outputDir:`${output}/playwright`,reporter:[['list'],['json',{outputFile:`${output}/playwright-results.json`}]],
  use:{baseURL:'http://127.0.0.1:18109',headless:true,viewport:{width:1440,height:1000},launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined},trace:'retain-on-failure',screenshot:'only-on-failure'},
});
