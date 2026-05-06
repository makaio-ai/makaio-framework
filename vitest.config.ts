import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the Makaio Framework standalone repo.
 *
 * Covers standalone framework unit tests across source areas. Browser tests,
 * E2E smoke tests, and live SDK tests run through explicit package scripts.
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
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'build-tooling/**/*.test.ts',
            'scripts/**/*.test.ts',
            'packages/**/*.test.ts',
            'adapters/core/**/*.test.ts',
            'clients/**/*.test.ts',
            'extensions/**/*.test.ts',
            'platforms/**/*.test.ts',
            'runtimes/**/*.test.ts',
            'tools/**/*.test.ts',
            'transports/**/*.test.ts',
            'ui/**/*.test.ts',
            'apps/**/*.test.ts',
          ],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/*.spec.ts',
            '**/.tmp/**',
            '**/*.browser.test.ts',
            '**/*.browser.test.tsx',
            '**/*.e2e.test.ts',
            'apps/cli/e2e/**',
            'apps/electron/e2e/**',
            'e2e/**',
            'sdks/e2e/**',
            'extensions/**/load-pipeline.test.ts',
            // References an out-of-tree log importer package. Excluded from the
            // standalone framework test suite and covered where that package is available.
            'packages/services/log-import/src/__tests__/import-from-file-content.integration.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'ui-jsdom',
          environment: 'jsdom',
          include: ['packages/**/*.test.tsx', 'extensions/**/*.test.tsx', 'ui/**/*.test.tsx', 'apps/**/*.test.tsx'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts', '**/*.browser.test.tsx'],
        },
      },
      {
        extends: true,
        test: {
          name: 'adapters',
          include: ['adapters/implementations/**/*.test.ts', 'adapters/shared/**/*.test.ts'],
          exclude: [
            '**/node_modules/**',
            '**/*.integration.test.ts',
            // These are adapter-conformance templates: importing them directly
            // requires MAKAIO_TEST_ADAPTER and a provider-backed test config.
            // Keep the default suite deterministic; run them through the
            // credentialed adapter harness instead.
            'adapters/implementations/__tests__/**',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'adapters-integration',
          include: ['adapters/implementations/**/*.integration.test.ts', 'adapters/shared/**/*.integration.test.ts'],
          exclude: [
            '**/node_modules/**',
            // See the adapters project above: these files are not standalone
            // integration specs and need the adapter harness environment.
            'adapters/implementations/__tests__/**',
          ],
        },
      },
    ],
  },
  resolve: {
    tsconfigPaths: true,
  },
});
