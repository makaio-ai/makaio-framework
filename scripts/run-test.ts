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
import { frameworkShards, inferCategory, resolveShardForFile, type TestCategory } from './lib/vitest-categories.js';

const SCRIPT_DIR = import.meta.dirname;
const FRAMEWORK_ROOT = resolve(SCRIPT_DIR, '..');

/**
 * Checks whether an argument looks like a test file path.
 * @param arg - CLI argument.
 * @returns True if the argument matches a test file suffix pattern.
 */
function looksLikeTestFile(arg: string): boolean {
  return /\.(test|integration\.test|spec)\.(tsx?|jsx?)$/.test(arg);
}

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
  execFileSync('yarn', ['vitest', 'run', ...args], {
    env: { ...process.env, CI: process.env.CI ?? 'true', ...env },
    stdio: 'inherit',
    cwd,
  });
}

/** Runs the full framework-only test suite with all categories enabled. */
function runFullSuiteFrameworkOnly(): void {
  runVitest([], FRAMEWORK_ROOT, { MAKAIO_TEST_CATEGORIES: 'unit,ui,integration' });
}

/** Runs the requested framework tests. */
function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    runFullSuiteFrameworkOnly();
    return;
  }

  const testFiles = args.filter((a) => looksLikeTestFile(a));
  const otherArgs = args.filter((a) => !looksLikeTestFile(a));

  if (testFiles.length === 0) {
    runVitest(args, FRAMEWORK_ROOT);
    return;
  }

  for (const file of testFiles) {
    const normalizedFile = normalizeFilePath(file);
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
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
