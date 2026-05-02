import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { createRepoDevAliases, isRepoDevMode } from './scripts/package-mode.js';

const extensionRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: '.',
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      // Post-build integration test — requires `yarn build` before it can run.
      '**/load-pipeline.test.ts',
    ],
  },
  resolve: {
    tsconfigPaths: true,
    ...(isRepoDevMode()
      ? {
          alias: createRepoDevAliases(extensionRoot),
        }
      : {}),
  },
});
