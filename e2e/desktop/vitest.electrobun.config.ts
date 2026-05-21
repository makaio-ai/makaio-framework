/**
 * Vitest configuration for desktop Electrobun E2E tests.
 *
 * These tests spawn a real Electrobun process without host runtime config and
 * assert source-checkout desktop behavior.
 */

import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = join(import.meta.dirname, '..', '..');

export default defineConfig({
  // resolve.tsconfigPaths is a Vite 8 native feature (not a plugin). It is
  // NOT a no-op — Vitest 4 extends Vite's config and this option enables
  // tsconfig path alias resolution without the vite-tsconfig-paths plugin.
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: 'desktop-electrobun-e2e',
    root: repoRoot,
    include: ['e2e/desktop/electrobun/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 20_000,
    onConsoleLog: () => false,
  },
});
