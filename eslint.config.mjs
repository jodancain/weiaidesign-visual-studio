import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import tsParser from '@typescript-eslint/parser';

export default defineConfig([
  ...nextVitals,
  {files:['**/*.d.mts'],languageOptions:{parser:tsParser}},
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'test-results/**', 'playwright-report/**', 'runtime/**', 'public/vendor/**']),
]);
