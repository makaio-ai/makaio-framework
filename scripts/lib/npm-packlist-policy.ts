/**
 * npm packlist policy checker.
 *
 * Validates that packages publish the right files — required metadata present
 * and no source, test, or build-config artifacts leaked into the tarball.
 * @packageDocumentation
 */

/** Result of a packlist policy check for a single package. */
export interface PacklistPolicyResult {
  readonly packageName: string;
  readonly missingRequired: readonly string[];
  readonly forbidden: readonly string[];
}

const FORBIDDEN_PATTERNS = [
  /(^|\/)src\//,
  /(^|\/)__tests__\//,
  /(^|\/)(test|tests|fixtures|coverage)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.snap$/,
  /\.map$/,
  /\.tsbuildinfo$/,
  /(^|\/)\.env/,
  /(^|\/)(build|vite|tsdown|vitest|tsconfig|eslint|prettier)(\.config)?\.[cm]?[jt]s(on)?$/,
  /(^|\/)(pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/,
  /(^|\/)(npm-debug|yarn-error)\.log$/,
];

/**
 * Check a package's file list against the npm packlist policy.
 * @param packageName - Package name for reporting.
 * @param files - File paths from `npm pack --dry-run --json`.
 * @returns Policy check result with missing required files and forbidden artifacts.
 */
export function checkPacklist(packageName: string, files: readonly string[]): PacklistPolicyResult {
  const fileSet = new Set(files);
  const required = ['package.json', 'README.md', 'LICENSE'];
  const missingRequired = required.filter((file) => !fileSet.has(file));
  const forbidden = files.filter((file) => FORBIDDEN_PATTERNS.some((pattern) => pattern.test(file)));
  return { packageName, missingRequired, forbidden };
}
