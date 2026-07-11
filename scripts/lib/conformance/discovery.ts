import { existsSync, readFileSync, readdirSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { pathToFileURL } from 'url';
import { globby } from 'globby';
import type { ConformanceTestConfig, CreateConformanceTestConfigOptions } from '@makaio/ai-adapters-core';
import { ROOT, ADAPTERS_PATH, CONFORMANCE_PATH } from './types.js';
import { loadConformanceProviderDefinitions } from './provider-catalog.js';

/**
 * Normalize path separators for globs and framework-relative matching.
 * @param value - Native platform path or glob
 * @returns Path with forward-slash separators
 */
function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Resolve the adapter conformance entrypoint, preferring an adapter-owned test entrypoint.
 * @param adapterName - Adapter directory name
 * @returns Adapter module path to import
 */
function resolveAdapterTestConfigPath(adapterName: string): string {
  const testEntrypoint = join(ADAPTERS_PATH, adapterName, 'src/test/index.ts');
  return existsSync(testEntrypoint)
    ? join(ADAPTERS_PATH, adapterName, 'src/test/index.js')
    : join(ADAPTERS_PATH, adapterName, 'src/index.js');
}

/**
 * Discovers available adapter directories.
 * @returns Array of adapter directory names
 */
export function discoverAdapters(): string[] {
  return readdirSync(ADAPTERS_PATH, { withFileTypes: true })
    .filter(
      (dirent) =>
        dirent.isDirectory() &&
        !dirent.name.includes('__') &&
        !dirent.name.startsWith('.') &&
        !dirent.name.includes('node_modules'),
    )
    .map((dirent) => dirent.name)
    .filter((adapterName) => {
      const descriptorPath = join(ADAPTERS_PATH, adapterName, 'descriptor.json');
      if (!existsSync(descriptorPath)) return false;
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as {
        contributions?: { adapters?: readonly unknown[] };
      };
      return (descriptor.contributions?.adapters?.length ?? 0) > 0;
    });
}

/**
 * Loads adapter config to get concurrency settings.
 *
 * Calls `createTestConfig()` only to read static options (e.g. concurrency)
 * and immediately invokes the config's `cleanup` hook to release any
 * infrastructure (e.g. MCP HTTP server) that the factory started eagerly.
 * @param adapterName - Name of the adapter to load config for
 * @returns Config object with concurrency, or null if not found
 */
export async function loadAdapterConfig(
  adapterName: string,
): Promise<{ concurrency?: number; defaultTimeout?: number } | null> {
  try {
    const adapterPath = resolveAdapterTestConfigPath(adapterName);
    const module = (await import(pathToFileURL(adapterPath).href)) as {
      createTestConfig?: (options?: CreateConformanceTestConfigOptions) => Promise<ConformanceTestConfig>;
    };
    if (!module.createTestConfig) return null;
    const config = await module.createTestConfig({
      providerDefinitions: await loadConformanceProviderDefinitions(),
    });
    const concurrency = config.options?.concurrency;
    const defaultTimeout = config.options?.defaultTimeout;
    try {
      await config.cleanup?.();
    } catch (error) {
      console.error(`Adapter config cleanup failed: ${adapterName}`, error);
    }
    return { concurrency, defaultTimeout };
  } catch (e) {
    console.error(`Failed to load adapter config: ${adapterName}`, e);
    return null;
  }
}

/**
 * Normalizes a user-supplied conformance test pattern to the test directory root.
 * @param pattern - Glob, test basename, or repo/framework-relative path
 * @returns Pattern relative to the conformance test directory
 */
function normalizeConformancePattern(pattern: string): string {
  const posixPattern = toPosixPath(pattern);
  const absolutePath = isAbsolute(pattern) ? pattern : resolve(ROOT, posixPattern);
  const relativeToConformance = toPosixPath(relative(CONFORMANCE_PATH, absolutePath));
  let normalized =
    !relativeToConformance.startsWith('..') && relativeToConformance !== '' ? relativeToConformance : posixPattern;

  normalized = toPosixPath(normalized);
  const conformanceRelative = `${toPosixPath(relative(ROOT, CONFORMANCE_PATH))}/`;
  if (normalized.startsWith(conformanceRelative)) normalized = normalized.slice(conformanceRelative.length);
  const nestedConformanceRelative = `/${conformanceRelative}`;
  const nestedIndex = normalized.indexOf(nestedConformanceRelative);
  if (nestedIndex !== -1) normalized = normalized.slice(nestedIndex + nestedConformanceRelative.length);
  if (normalized.includes('*') || normalized.includes('/') || normalized.endsWith('.ts')) return normalized;
  return `**/*${normalized}*.test.ts`;
}

/**
 * Discovers conformance test files matching the given patterns.
 * @param patterns - Glob patterns for test files
 * @param excludePatterns - Glob patterns for test files to exclude after expansion
 * @returns Array of absolute paths to matching test files
 */
export async function discoverConformanceTests(patterns: string[], excludePatterns: string[] = []): Promise<string[]> {
  const effectivePatterns = patterns.length > 0 ? patterns : ['**/*.test.ts'];
  const expandedPatterns = effectivePatterns.map(normalizeConformancePattern);
  const expandedExcludes = excludePatterns.map(normalizeConformancePattern);

  const files = await globby(expandedPatterns, {
    cwd: CONFORMANCE_PATH,
    absolute: true,
    ignore: ['**/*.integration.test.ts', '**/node_modules/**', ...expandedExcludes],
  });
  return files.sort();
}
