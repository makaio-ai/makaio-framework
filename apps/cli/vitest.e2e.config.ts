/**
 * Vitest configuration for CLI E2E tests.
 *
 * E2E tests spawn a real CLI serve process and connect to its WebSocket bus,
 * so they need:
 * - `pool: 'forks'` — isolates each test file in its own process for port safety
 * - `fileParallelism: false` — runs test files sequentially to avoid resource contention
 * - `testTimeout: 60000` — service boot can take several seconds
 * - `hookTimeout: 15000` — afterEach/afterAll cleanup needs headroom
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: 'cli-e2e',
    root: 'framework/apps/cli',
    include: ['e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 15_000,
    // Suppress console output from the test process itself (child process
    // output is forwarded deliberately inside the harness via process.stdout).
    onConsoleLog: () => false,
  },
});
