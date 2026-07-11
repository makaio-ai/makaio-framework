#!/usr/bin/env bun
/**
 * Run only explicit Bun-owned framework tests.
 *
 * The runner always resolves `.bun.test.*` files before invoking `bun test`.
 * This prevents Bun's broad built-in discovery from executing Vitest-owned
 * test files.
 */

import { relative, resolve } from 'node:path';
import { globby } from 'globby';
import { BUN_TEST_FILE_GLOBS, isBunTestFile, isTestFile } from './lib/test-runner-contract.js';

const FRAMEWORK_ROOT = resolve(import.meta.dirname, '..');
const BUN_OPTIONS_WITH_VALUE = new Set([
  '--test-name-pattern',
  '-t',
  '--timeout',
  '--rerun-each',
  '--retry',
  '--max-concurrency',
  '--reporter',
  '--reporter-outfile',
  '--coverage-reporter',
  '--coverage-dir',
  '--path-ignore-patterns',
  '--seed',
  '--preload',
  '--env-file',
]);
const BUN_OPTIONS_WITH_OPTIONAL_VALUE = new Set(['--bail']);

/** Parsed Bun test files and Bun CLI arguments. */
export interface BunTestArguments {
  /** Explicit Bun-owned test file paths. */
  readonly files: string[];
  /** Bun test options passed through unchanged. */
  readonly options: string[];
}

/**
 * Separates explicit test paths from Bun CLI options.
 * @param arguments_ - Raw arguments after the runner script path
 * @returns Explicit file paths and passthrough Bun options
 */
export function splitBunTestArguments(arguments_: readonly string[]): BunTestArguments {
  const files: string[] = [];
  const options: string[] = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (isTestFile(argument)) {
      files.push(argument);
      continue;
    }
    if (!argument.startsWith('-')) {
      throw new Error(`Bun runner accepts only explicit *.bun.test.ts(x) files; received: ${argument}`);
    }
    options.push(argument);
    const value = arguments_[index + 1];
    const requiresValue = BUN_OPTIONS_WITH_VALUE.has(argument);
    const acceptsOptionalValue = BUN_OPTIONS_WITH_OPTIONAL_VALUE.has(argument);
    const consumesValue =
      !argument.includes('=') &&
      (requiresValue || (acceptsOptionalValue && value !== undefined && !value.startsWith('-') && !isTestFile(value)));
    if (consumesValue) {
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`Bun option requires a value: ${argument}`);
      }
      options.push(value);
      index++;
    }
  }
  return { files, options };
}

/**
 * Resolve explicit Bun test files, or discover the complete framework Bun surface.
 * @param fileArguments - Optional framework- or checkout-relative test file arguments
 * @returns Absolute Bun test file paths in deterministic order
 */
export async function resolveBunTestFiles(fileArguments: readonly string[]): Promise<string[]> {
  if (fileArguments.length === 0) {
    const discovered = await globby([...BUN_TEST_FILE_GLOBS], { cwd: FRAMEWORK_ROOT, absolute: true, onlyFiles: true });
    return discovered.sort();
  }

  const resolved = fileArguments.map((argument) => {
    const normalizedArgument = argument.replace(/^\.\//, '');
    const relativeArgument = normalizedArgument.startsWith('framework/')
      ? normalizedArgument.slice('framework/'.length)
      : normalizedArgument;
    const filePath = resolve(FRAMEWORK_ROOT, relativeArgument);
    if (!isBunTestFile(filePath)) {
      throw new Error(`Bun runner accepts only *.bun.test.ts(x) files; received: ${argument}`);
    }
    return filePath;
  });
  return [...new Set(resolved)].sort();
}

/**
 * Execute the selected Bun-owned test files.
 * @param fileArguments - Optional framework- or checkout-relative test file arguments
 * @param options - Bun test options passed through unchanged
 * @returns Process exit code
 */
export async function runBunTests(fileArguments: readonly string[], options: readonly string[] = []): Promise<number> {
  const files = await resolveBunTestFiles(fileArguments);
  if (files.length === 0) {
    console.info('No Bun-owned framework tests selected.');
    return 0;
  }

  const displayFiles = files.map((filePath) => relative(FRAMEWORK_ROOT, filePath));
  console.info(
    `Bun test surface (${displayFiles.length} file${displayFiles.length === 1 ? '' : 's'}): ${displayFiles.join(', ')}`,
  );
  const child = Bun.spawn({
    cmd: [Bun.argv[0], 'test', ...(process.env['AI_AGENT'] ? ['--only-failures'] : []), ...options, ...files],
    cwd: FRAMEWORK_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  return await child.exited;
}

if (import.meta.main) {
  const { files, options } = splitBunTestArguments(process.argv.slice(2));
  process.exit(await runBunTests(files, options));
}
