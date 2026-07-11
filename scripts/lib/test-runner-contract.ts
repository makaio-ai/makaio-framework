/**
 * Test-file ownership contract shared by runner entrypoints.
 *
 * Legacy generic test suffixes remain Vitest-owned until their individual
 * migration. New Bun files must use the explicit Bun suffix so broad Vitest
 * project globs can exclude them reliably.
 */

/** Glob patterns that identify Bun-owned test files. */
export const BUN_TEST_FILE_GLOBS = ['**/*.bun.test.ts', '**/*.bun.test.tsx'] as const;

const BUN_TEST_FILE_PATTERN = /\.bun\.test\.(?:ts|tsx)$/;
const TEST_FILE_PATTERN = /(?:\.test|\.spec)\.(?:ts|tsx|js|jsx)$/;

/**
 * Checks whether a path is owned by the Bun test runner.
 * @param filePath - Repository- or framework-relative test path
 * @returns True when the path has the explicit Bun test suffix
 */
export function isBunTestFile(filePath: string): boolean {
  return BUN_TEST_FILE_PATTERN.test(filePath);
}

/**
 * Checks whether an argument has a supported test-file suffix.
 * @param filePath - User-supplied path or test file path
 * @returns True when the path is a supported test file
 */
export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERN.test(filePath);
}

/**
 * Removes an explicit runner affix before category classification.
 * @param filePath - Test file path
 * @returns Path with `.bun` or `.vitest` removed immediately before `.test`
 */
export function removeTestRunnerAffix(filePath: string): string {
  return filePath.replace(/\.(?:bun|vitest)(?=\.test\.(?:ts|tsx|js|jsx)$)/, '');
}
