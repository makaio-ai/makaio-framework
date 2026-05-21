/**
 * Vitest configuration for Makaio Framework.
 *
 * Test categories are controlled by MAKAIO_TEST_CATEGORIES (comma-separated).
 * Default: unit,ui,integration
 *
 * Categories:
 *   unit        — *.test.ts   (node environment)
 *   ui          — *.test.tsx  (jsdom; each file uses // \@vitest-environment jsdom)
 *   integration — *.integration.test.ts
 *   adapters    — adapters only (subset of unit, for isolated runs)
 *
 * CI shards are mapped to named Vitest projects and selected via --project:
 *   yarn vitest run --project Core         # core/ + storage/
 *   yarn vitest run --project Platform     # platforms/ runtimes/ transports/ …
 *
 * Usage:
 *   yarn test                              # all projects, default categories
 *   yarn test:unit                         # unit only
 *   yarn test:ui                           # ui/jsdom only
 *   yarn test:integration                  # integration only
 *   yarn test --dir core/bus-core          # all categories, scoped to bus-core
 *   yarn workspace \@makaio/bus-core test   # same, from package directory
 *
 * E2E, browser, SDK, and conformance tests have separate configs and scripts.
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const root = import.meta.dirname;

const enabledCategories = new Set(
  (process.env.MAKAIO_TEST_CATEGORIES ?? 'unit,ui,integration').split(',').map((c) => c.trim()),
);

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

if (!enabledCategories.has('integration')) {
  exclude.push('**/*.integration.test.ts');
}

const shards: Record<string, string[]> = {
  Core: ['core', 'storage'],
  Packages: ['packages'],
  Platform: ['platforms', 'runtimes', 'transports', 'clients', 'providers', 'scripts', 'build-tooling'],
  Adapters: ['adapters'],
  Extensions: ['extensions'],
  Apps: ['apps', 'ui', 'sdks'],
};

function categoryIncludes(dirs: string[]): string[] {
  const patterns: string[] = [];
  const wantUnit = enabledCategories.has('unit');
  const wantAdapters = enabledCategories.has('adapters') && !wantUnit;

  for (const dir of dirs) {
    if (wantUnit || (wantAdapters && dir === 'adapters')) {
      patterns.push(`${dir}/**/*.test.ts`);
    }
    if (enabledCategories.has('ui')) patterns.push(`${dir}/**/*.test.tsx`);
    if (enabledCategories.has('integration')) patterns.push(`${dir}/**/*.integration.test.ts`);
  }
  return patterns;
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
    exclude,
    projects: Object.entries(shards).map(([name, dirs]) => ({
      extends: true,
      test: {
        name,
        include: categoryIncludes(dirs),
      },
    })),
  },
  resolve: {
    tsconfigPaths: true,
  },
});
