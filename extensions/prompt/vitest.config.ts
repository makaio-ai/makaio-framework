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
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
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
