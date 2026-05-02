import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the Makaio Framework standalone repo.
 *
 * Covers all unit tests for packages, adapters (core only), tools,
 * transports, and apps — excluding browser/e2e tests and adapter
 * integration tests that make real API calls.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    reporters: ['./scripts/lib/token-efficient-reporter.ts'],
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: '50%',
    onConsoleLog: () => (process.env.MAKAIO_DEBUG ? undefined : false),
    include: [
      'packages/**/*.test.ts',
      'adapters/core/**/*.test.ts',
      'tools/**/*.test.ts',
      'transports/**/*.test.ts',
      'runtimes/**/*.test.ts',
      'apps/**/*.test.ts',
      'apps/**/*.test.tsx',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.spec.ts',
      '**/.tmp/**',
      'apps/electron/e2e/**',
      // References an out-of-tree log importer package. Excluded from the
      // standalone framework test suite and covered where that package is available.
      'packages/services/log-import/src/__tests__/import-from-file-content.integration.test.ts',
    ],
  },
  resolve: {
    tsconfigPaths: true,
  },
});
