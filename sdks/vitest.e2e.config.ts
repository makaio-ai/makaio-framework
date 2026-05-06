/**
 * Vitest configuration for SDK E2E tests.
 *
 * These tests make real Anthropic API calls via OAuth and are NOT included in
 * the standard test suite. Run explicitly via `yarn test:sdks`.
 *
 * The test spawns a full `makaio serve` runtime, creates a Python venv, builds
 * a Rust binary, and makes real API calls — generous timeouts are required.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: 'sdk-e2e',
    root: 'sdks',
    include: ['e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 600_000,
    // beforeAll boots runtime + creates Python venv + pip install; match testTimeout
    // to avoid flaky aborts on slow machines/networks.
    hookTimeout: 600_000,
    onConsoleLog: () => (process.env['MAKAIO_DEBUG'] ? undefined : false),
  },
});
