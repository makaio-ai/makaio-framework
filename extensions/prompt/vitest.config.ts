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
