/**
 * Shared test category logic for Vitest configurations.
 *
 * Both the framework config and any outer workspace config use categories +
 * shard tables to determine which test files to include. This module provides
 * the common logic.
 */

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
 * Infers the test category from a file's name suffix.
 * @param filePath - Test file path.
 */
export function inferCategory(filePath: string): TestCategory {
  if (filePath.endsWith('.integration.test.ts')) return 'integration';
  if (filePath.endsWith('.test.tsx')) return 'ui';
  return 'unit';
}
