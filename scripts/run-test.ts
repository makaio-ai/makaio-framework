#!/usr/bin/env bun
/**
 * Smart test runner that resolves `yarn test <file>` into the correct Vitest
 * invocation for framework tests regardless of test category.
 * @example
 * ```bash
 * yarn test packages/services/log-import/src/__tests__/import-from-file-content.integration.test.ts
 * yarn test                               # full suite
 * yarn test --project Core --reporter verbose  # passthrough
 * ```
 */

import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  FORKS_REQUIRED_FILES,
  FORKS_REQUIRED_PROJECT_NAME,
  FRAMEWORK_SPECIAL_PROJECT_NAMES,
  GIT_SERIAL_PROJECT_NAME,
  GIT_SERIAL_TEST_GLOBS,
  frameworkShards,
  inferCategory,
  resolveShardForFile,
  type TestCategory,
} from './lib/vitest-categories.js';
import { isBunTestFile, isTestFile } from './lib/test-runner-contract.js';
import {
  heapNodeOptions,
  runFullSuite,
  type FullSuiteBatchContext,
  type FullSuitePlanConfig,
} from './lib/full-suite-runner.js';

const SCRIPT_DIR = import.meta.dirname;
const FRAMEWORK_ROOT = resolve(SCRIPT_DIR, '..');
const BUN_TEST_BATCH_NAME = 'bun';

/** Framework project tables for the shared full-suite orchestration. */
const FRAMEWORK_SUITE_CONFIG: FullSuitePlanConfig = {
  broadProjects: Object.keys(frameworkShards),
  broadBatchSize: 2,
  specialProjects: FRAMEWORK_SPECIAL_PROJECT_NAMES,
  // Both sides intentionally read the same constant. This workspace's Vitest
  // config names its special projects through FORKS_REQUIRED_PROJECT_NAME and
  // GIT_SERIAL_PROJECT_NAME, so scheduler/config drift is prevented by
  // construction rather than detected at run time. The plan-level guard still
  // does real work for a workspace that maintains its scheduled list separately
  // from the declaration, which is why the field stays on the shared contract.
  declaredSpecialProjects: FRAMEWORK_SPECIAL_PROJECT_NAMES,
  bunBatchName: BUN_TEST_BATCH_NAME,
};

/**
 * Checks whether an argument looks like a test file path.
 * @param arg - CLI argument.
 * @returns True if the argument matches a test file suffix pattern.
 */
/**
 * Normalizes a user-provided file path to be relative to the vitest config root.
 * @param inputPath - Raw path from CLI.
 * @returns The normalized path relative to the framework root.
 */
function normalizeFilePath(inputPath: string): string {
  const absPath = isAbsolute(inputPath) ? inputPath : resolve(process.cwd(), inputPath);
  return relative(FRAMEWORK_ROOT, absPath).split(sep).join('/');
}

interface ResolvedTest {
  category: TestCategory;
  shard: string;
  relativePath: string;
}

/**
 * Resolves a test file path into its shard and category.
 * @param inputPath - User-provided file path.
 * @returns Resolved test metadata, or null if no shard matched.
 */
function resolveTest(inputPath: string): ResolvedTest | null {
  const relativePath = normalizeFilePath(inputPath);
  const category = inferCategory(relativePath);
  if (FORKS_REQUIRED_FILES.includes(relativePath)) {
    return { category, shard: FORKS_REQUIRED_PROJECT_NAME, relativePath };
  }
  if (GIT_SERIAL_TEST_GLOBS.some((glob) => relativePath.startsWith(glob.replace('/**/*.test.ts', '/')))) {
    return { category, shard: GIT_SERIAL_PROJECT_NAME, relativePath };
  }
  const shard = resolveShardForFile(relativePath, frameworkShards);
  if (!shard) return null;
  return { category, shard, relativePath };
}

/**
 * Executes a Vitest run through Yarn.
 * @param args - Arguments passed after `vitest run`.
 * @param cwd - Working directory.
 * @param env - Additional environment variables.
 */
function runVitest(args: string[], cwd: string, env?: Record<string, string>): void {
  execFileSync('yarn', ['exec', 'vitest', 'run', ...args], {
    env: { ...process.env, CI: process.env.CI ?? 'true', ...env },
    stdio: 'inherit',
    cwd,
  });
}

/**
 * Executes Bun-owned framework tests through the explicit runner.
 * @param filePaths - Optional framework-relative Bun test file paths
 * @param options - Bun test options passed through unchanged
 */
function runBunTests(filePaths: string[], options: string[] = []): void {
  execFileSync('bun', ['scripts/run-bun-tests.ts', ...options, ...filePaths], {
    env: { ...process.env, CI: process.env.CI ?? 'true' },
    stdio: 'inherit',
    cwd: FRAMEWORK_ROOT,
  });
}

/**
 * Execute one framework plan batch in a child process.
 * @param projects - Projects executed by the batch.
 * @param context - Batch execution context from the shared runner.
 */
async function executeFrameworkBatch(projects: readonly string[], context: FullSuiteBatchContext): Promise<void> {
  if (projects[0] === BUN_TEST_BATCH_NAME) {
    runBunTests([]);
    return;
  }
  const nodeOptions = heapNodeOptions(context, process.env.NODE_OPTIONS);
  runVitest(
    [
      ...projects.flatMap((project) => ['--project', project]),
      ...(context.maxWorkers ? ['--maxWorkers', String(context.maxWorkers)] : []),
    ],
    FRAMEWORK_ROOT,
    {
      MAKAIO_TEST_CATEGORIES: 'unit,ui,integration',
      ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    },
  );
}

/**
 * Runs the full framework-only test suite with all categories enabled.
 * @returns Exit status of the full-suite plan.
 */
function runFullSuiteFrameworkOnly(): Promise<number> {
  return runFullSuite({
    config: FRAMEWORK_SUITE_CONFIG,
    executeBatch: executeFrameworkBatch,
  });
}

/** Runs the requested framework tests. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    process.exitCode = await runFullSuiteFrameworkOnly();
    return;
  }

  const testFiles = args.filter((a) => isTestFile(a));
  const otherArgs = args.filter((a) => !isTestFile(a));

  if (testFiles.length === 0) {
    runVitest(args, FRAMEWORK_ROOT);
    return;
  }

  for (const file of testFiles) {
    const normalizedFile = normalizeFilePath(file);
    if (isBunTestFile(normalizedFile)) {
      console.info(`${normalizedFile}\n  runner: bun\n`);
      runBunTests([normalizedFile], otherArgs);
      continue;
    }
    const resolved = resolveTest(file);
    if (!resolved) {
      console.error(`Could not resolve shard for: ${file}`);
      console.error('Falling back to vitest auto-resolution.');
      const fallbackFile = normalizedFile.startsWith('../') ? file : normalizedFile;
      runVitest([...otherArgs, fallbackFile], FRAMEWORK_ROOT);
      continue;
    }

    const { category, shard, relativePath } = resolved;
    console.info(`${relativePath}\n  shard: ${shard}  category: ${category}\n`);

    runVitest(['--project', shard, ...otherArgs, relativePath], FRAMEWORK_ROOT, { MAKAIO_TEST_CATEGORIES: category });
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
