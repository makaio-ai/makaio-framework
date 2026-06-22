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
import type { TestProjectConfiguration } from 'vitest/config';
import { resolve } from 'path';
import {
  categoryIncludes,
  fileMatchesCategories,
  FORKS_REQUIRED_FILES,
  GIT_SERIAL_TEST_GLOBS,
  frameworkShards as shards,
  FRAMEWORK_ADAPTER_DIRS as ADAPTER_DIRS,
  parseTestCategories,
} from './scripts/lib/vitest-categories.js';

const root = import.meta.dirname;

const enabledCategories = parseTestCategories(process.env.MAKAIO_TEST_CATEGORIES);
const forksRequiredInclude = FORKS_REQUIRED_FILES.filter((file) =>
  fileMatchesCategories(file, enabledCategories, ADAPTER_DIRS),
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

/** Re-export for the test runner script and CI. */
export { shards };

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    reporters: [resolve(root, 'scripts/lib/token-efficient-reporter.ts')],
    setupFiles: ['dotenv/config', resolve(root, 'vitest.setup.ts')],
    pool: 'threads',
    fileParallelism: true,
    onConsoleLog: () => (process.env.MAKAIO_DEBUG ? undefined : false),
    exclude,
    projects: [
      ...Object.entries(shards).map(
        ([name, dirs]): TestProjectConfiguration => ({
          extends: true,
          test: {
            name,
            exclude: [...exclude, ...FORKS_REQUIRED_FILES, ...GIT_SERIAL_TEST_GLOBS],
            include: categoryIncludes(dirs, enabledCategories, ADAPTER_DIRS),
          },
        }),
      ),
      {
        extends: true,
        test: {
          name: 'forks-required',
          pool: 'forks',
          include: forksRequiredInclude,
        },
      } satisfies TestProjectConfiguration,
      {
        extends: true,
        test: {
          name: 'git-serial',
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
          exclude,
          include: GIT_SERIAL_TEST_GLOBS,
        },
      } satisfies TestProjectConfiguration,
    ],
  },
  resolve: {
    tsconfigPaths: true,
  },
});
