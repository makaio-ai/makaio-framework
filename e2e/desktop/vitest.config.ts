/**
 * Vitest configuration for framework-only desktop Electron E2E tests.
 *
 * These tests spawn a real Electron process without host runtime config and
 * assert standalone-framework desktop behavior.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // resolve.tsconfigPaths is a Vite 8 native feature (not a plugin). It is
  // NOT a no-op — Vitest 4 extends Vite's config and this option enables
  // tsconfig path alias resolution without the vite-tsconfig-paths plugin.
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: 'framework-desktop-e2e',
    root: 'framework',
    include: ['e2e/desktop/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 20_000,
    onConsoleLog: () => false,
  },
});
