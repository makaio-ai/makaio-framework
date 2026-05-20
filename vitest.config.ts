/**
 * Vitest configuration for Makaio Framework.
 *
 * Test categories are controlled by MAKAIO_TEST_CATEGORIES (comma-separated).
 * Default: unit,ui
 *
 * Categories:
 *   unit        — *.test.ts   (node environment)
 *   ui          — *.test.tsx  (jsdom; each file uses // \@vitest-environment jsdom)
 *   integration — *.integration.test.ts
 *   adapters    — adapters only (subset of unit, for isolated runs)
 *
 * Usage:
 *   yarn test                              # unit + ui (default)
 *   yarn test:unit                         # unit only
 *   yarn test:ui                           # ui/jsdom only
 *   yarn test --dir packages/bus-core      # all categories, scoped to bus-core
 *   yarn workspace \@makaio/bus-core test   # same, from package directory
 *   MAKAIO_TEST_CATEGORIES=integration yarn test  # integration tests
 *
 * E2E, browser, SDK, and conformance tests have separate configs and scripts.
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

// Absolute paths so vitest resolves these correctly from package subdirectories.
const root = import.meta.dirname;

const enabledCategories = new Set((process.env.MAKAIO_TEST_CATEGORIES ?? 'unit,ui').split(',').map((c) => c.trim()));

const include: string[] = [];
const exclude: string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.tmp/**',
  '**/*.spec.ts',
  '**/*.browser.test.ts',
  '**/*.browser.test.tsx',
  '**/*.e2e.test.ts',
  'apps/cli/e2e/**',
  'apps/electron/e2e/**',
  'e2e/**',
  'sdks/e2e/**',
  'extensions/**/load-pipeline.test.ts',
  'adapters/implementations/__tests__/**',
];

if (enabledCategories.has('unit')) {
  include.push('**/*.test.ts');
}

if (enabledCategories.has('ui')) {
  include.push('**/*.test.tsx');
}

if (enabledCategories.has('integration')) {
  include.push('**/*.integration.test.ts');
} else {
  exclude.push('**/*.integration.test.ts');
}

if (enabledCategories.has('adapters') && !enabledCategories.has('unit')) {
  include.push('adapters/**/*.test.ts');
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    reporters: [resolve(root, 'scripts/lib/token-efficient-reporter.ts')],
    setupFiles: [resolve(root, 'vitest.setup.ts')],
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: '50%',
    onConsoleLog: () => (process.env.MAKAIO_DEBUG ? undefined : false),
    include,
    exclude,
  },
  resolve: {
    tsconfigPaths: true,
  },
});
