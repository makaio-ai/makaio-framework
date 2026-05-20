import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { createRepoDevAliases, isRepoDevMode } from './scripts/package-mode.js';

const extensionRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(extensionRoot, '../..');

export default defineConfig({
  root: '.',
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.resolve(repoRoot, 'vitest.setup.ts')],
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
