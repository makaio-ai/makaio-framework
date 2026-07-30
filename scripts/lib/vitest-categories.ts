/**
 * Shared test category logic for Vitest configurations.
 *
 * Both the framework config and any outer workspace config use categories +
 * shard tables to determine which test files to include. This module provides
 * the common logic.
 */

import { devNull } from 'node:os';
import { removeTestRunnerAffix } from './test-runner-contract.js';

export type TestCategory = 'unit' | 'ui' | 'integration' | 'adapters';

const DEFAULT_CATEGORIES: readonly TestCategory[] = ['unit', 'ui', 'integration'];
const VALID_CATEGORIES: ReadonlySet<string> = new Set<TestCategory>(['unit', 'ui', 'integration', 'adapters']);

/**
 * Checks whether a string is a known test category.
 * @param value - Category token from MAKAIO_TEST_CATEGORIES.
 * @returns True when the token is a supported category.
 */
function isTestCategory(value: string): value is TestCategory {
  return VALID_CATEGORIES.has(value);
}

/**
 * Parses the MAKAIO_TEST_CATEGORIES environment variable into a set of categories.
 * @param envValue - Raw comma-separated value. Defaults to unit,ui,integration.
 */
export function parseTestCategories(envValue?: string): Set<TestCategory> {
  const raw = envValue ?? DEFAULT_CATEGORIES.join(',');
  const tokens = raw
    .split(',')
    .map((category) => category.trim())
    .filter(Boolean);

  const categories = new Set<TestCategory>();
  const unknown: string[] = [];
  for (const token of tokens) {
    if (isTestCategory(token)) {
      categories.add(token);
    } else {
      unknown.push(token);
    }
  }

  if (unknown.length > 0 || tokens.length === 0) {
    throw new Error(`Invalid MAKAIO_TEST_CATEGORIES value(s): ${unknown.length > 0 ? unknown.join(', ') : raw}`);
  }

  return categories;
}

/**
 * Builds glob include patterns for the given directories and enabled categories.
 *
 * The `adapters` category is a scoped subset of `unit`: when active (and `unit`
 * is not), only directories listed in `adapterDirs` receive `*.test.ts` patterns.
 * @param dirs - Workspace directories (relative to the vitest root).
 * @param categories - Enabled test categories.
 * @param adapterDirs - Directories that qualify for the `adapters` category.
 */
export function categoryIncludes(dirs: string[], categories: Set<TestCategory>, adapterDirs?: Set<string>): string[] {
  const patterns: string[] = [];
  const wantUnit = categories.has('unit');
  const wantAdapters = categories.has('adapters') && !wantUnit;

  for (const dir of dirs) {
    if (wantUnit || (wantAdapters && adapterDirs?.has(dir))) {
      patterns.push(`${dir}/**/*.test.ts`);
    }
    if (categories.has('ui')) patterns.push(`${dir}/**/*.test.tsx`);
    if (categories.has('integration')) patterns.push(`${dir}/**/*.integration.test.ts`);
  }
  return patterns;
}

/**
 * Checks whether an explicit test file belongs to the enabled category set.
 * @param filePath - File path relative to the active Vitest root.
 * @param categories - Enabled test categories.
 * @param adapterDirs - Directories that qualify for the `adapters` category.
 */
export function fileMatchesCategories(
  filePath: string,
  categories: Set<TestCategory>,
  adapterDirs?: Set<string>,
): boolean {
  const category = inferCategory(filePath);
  if (category !== 'unit') return categories.has(category);
  if (categories.has('unit')) return true;
  return categories.has('adapters') && Boolean(adapterDirs && matchesAnyPrefix(filePath, adapterDirs));
}

/**
 * Checks whether a file path belongs to one of the candidate directories.
 * @param filePath - File path relative to the active Vitest root.
 * @param dirs - Candidate shard directories.
 */
function matchesAnyPrefix(filePath: string, dirs: Set<string>): boolean {
  for (const dir of dirs) {
    if (filePath.startsWith(`${dir}/`)) return true;
  }
  return false;
}

/**
 * Resolves which shard a file path belongs to (longest-prefix match).
 * @param filePath - File path relative to the vitest root.
 * @param shards - Shard name → directory list mapping.
 */
export function resolveShardForFile(filePath: string, shards: Record<string, string[]>): string | undefined {
  let bestMatch: string | undefined;
  let bestLen = 0;
  for (const [name, dirs] of Object.entries(shards)) {
    for (const dir of dirs) {
      if (filePath.startsWith(`${dir}/`) && dir.length > bestLen) {
        bestMatch = name;
        bestLen = dir.length;
      }
    }
  }
  return bestMatch;
}

/**
 * Framework standalone shard table.
 * Directories are relative to the framework root.
 */
export const frameworkShards: Record<string, string[]> = {
  Core: ['core', 'services', 'storage'],
  Packages: ['packages'],
  Platform: ['platforms', 'runtimes', 'transports', 'clients', 'providers', 'scripts', 'build-tooling', 'subsystems'],
  Adapters: ['adapters'],
  Extensions: ['extensions'],
  Apps: ['apps', 'ui', 'sdks'],
};

export const FRAMEWORK_ADAPTER_DIRS = new Set(['adapters']);

/**
 * Test files that require process isolation (`forks` pool).
 * Paths are relative to the framework root.
 */
export const FORKS_REQUIRED_FILES: string[] = [
  // process.chdir() not supported in worker threads
  'storage/drizzle/src/__tests__/client.test.ts',
  'services/package-manager/src/__tests__/local-path-installer.test.ts',
  'scripts/lib/validate/validators/typescript-validator.test.ts',
  'runtimes/node/src/__tests__/makaio-config.test.ts',
  'runtimes/node/src/__tests__/extension-discovery.test.ts',
  'runtimes/node/src/__tests__/node-runtime-options.test.ts',
  // Requires process isolation for filesystem/global state
  'clients/claude-code/src/runtime/__tests__/client-settings.test.ts',
  'clients/claude-code/src/runtime/__tests__/wiring-config-dir.test.ts',
  'clients/claude-code/src/runtime/__tests__/session-config-handler.test.ts',
  'clients/claude-code/src/runtime/__tests__/claude-code-client-service.config.test.ts',
];

/**
 * Git subsystem tests spawn real git subprocesses against per-test temporary
 * repositories. Run them in a dedicated project so subprocess-heavy
 * files stay out of the broad thread-pool shards.
 */
export const GIT_SERIAL_TEST_GLOBS = ['subsystems/git/src/**/*.test.ts'];

/**
 * Environment for the git test lane.
 *
 * Neutralizes the developer's global/system git configuration (LFS filters,
 * exclude files, fsmonitor, and similar machine-specific behavior) so test
 * repositories behave identically on every machine. Disables git's fsync
 * calls and detached auto-maintenance: hundreds of short-lived test repos
 * otherwise spawn background `git maintenance` processes that contend on
 * repository locks and the temp filesystem.
 */
export const GIT_TEST_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
  GIT_TEST_FSYNC: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'maintenance.auto',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'gc.auto',
  GIT_CONFIG_VALUE_1: '0',
};

/**
 * Vitest group order for the git test lane.
 *
 * The lane exists so subprocess-heavy files stay out of the broad thread-pool
 * shards, but the full-suite plan selects every project in one Vitest process —
 * which would schedule the lane's git subprocesses alongside the broad shards
 * again, undoing the separation. Hundreds of concurrent `git` processes starve
 * other suites that shell out to git on a short budget, and those suites then
 * fail on timing rather than on behavior.
 *
 * A non-default `sequence.groupOrder` makes the lane its own Vitest group, so
 * it runs after group 0 within the same process. That keeps the single-process
 * plan's startup and memory win while restoring the isolation the lane was
 * created for, and it frees the lane to choose its own worker budget
 * independently of the run-wide one.
 */
export const GIT_TEST_GROUP_ORDER = 1;

/**
 * Infers the test category from a file's name suffix.
 * @param filePath - Test file path.
 */
export function inferCategory(filePath: string): TestCategory {
  const categoryPath = removeTestRunnerAffix(filePath);
  if (categoryPath.endsWith('.integration.test.ts')) return 'integration';
  if (categoryPath.endsWith('.test.tsx')) return 'ui';
  return 'unit';
}

/** Project name of the framework lane for tests requiring process isolation. */
export const FORKS_REQUIRED_PROJECT_NAME = 'forks-required';

/** Project name of the framework lane for git subprocess tests. */
export const GIT_SERIAL_PROJECT_NAME = 'git-serial';

/**
 * Project names for Vitest projects that are defined inline in the framework
 * vitest config but are not part of the standard shard table.
 * These projects handle special execution requirements (process isolation,
 * a pinned git environment) that the shard-based projects cannot express.
 *
 * `framework/vitest.config.ts`, the shard-coverage validator, and the
 * full-suite scheduler all name these projects through the constants above, so
 * a rename propagates to every consumer instead of silently splitting the
 * scheduler's view from the config's.
 */
export const FRAMEWORK_SPECIAL_PROJECT_NAMES: readonly string[] = [
  FORKS_REQUIRED_PROJECT_NAME,
  GIT_SERIAL_PROJECT_NAME,
];
