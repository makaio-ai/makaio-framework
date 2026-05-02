/**
 * Vitest configuration for Electron E2E tests.
 *
 * E2E tests spawn a real headless runtime process and connect to its WebSocket
 * bus, so they need:
 * - `pool: 'forks'` — isolates each test file in its own process for port safety
 * - `fileParallelism: false` — runs test files sequentially to avoid resource contention
 * - `testTimeout: 60000` — Electron-style service boot can take several seconds
 * - `hookTimeout: 20000` — afterEach/afterAll cleanup needs headroom
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: 'electron-e2e',
    root: import.meta.dirname,
    include: ['e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.e2e.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 20_000,
    // Suppress console output from the test process itself (child process
    // output is forwarded deliberately inside the harness via process.stdout).
    onConsoleLog: () => false,
  },
});
