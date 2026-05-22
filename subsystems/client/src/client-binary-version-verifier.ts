/**
 * Post-install version verification for managed client binaries.
 *
 * The verifier runs the `versionCommand` declared on a {@link ClientDefinition}
 * against the installed binary directory and confirms that the binary reports
 * the expected version string. This prevents a corrupted or incomplete install
 * from being activated and later failing at runtime.
 *
 * Security invariants enforced by the verifier:
 * - The command executable must be a relative path on POSIX and Windows hosts.
 * - The path must contain no `..` segments to prevent directory traversal.
 * - The executable and install directory are resolved through real paths before
 *   execution, so symlinks cannot redirect verification outside `installPath`.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isPathWithinBase } from './client-binary-paths.js';
import type { StrategyDependencies } from './binary-strategies/index.js';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Verifies that the binary installed at `installPath` reports the expected
 * version when executed with the declared `versionCommand`.
 *
 * The first element of `versionCommand` is resolved relative to `installPath`.
 * Absolute paths and any `..` segments are rejected to prevent path traversal.
 * The binary is executed with `{ cwd: installPath }` so relative paths within
 * the binary work as expected. Before execution, both the install directory
 * and resolved executable are canonicalized with `realpath()` so symlinked
 * executables cannot escape the install directory.
 *
 * Version strings are compared as output tokens after stripping a single
 * leading `v`, so `v1.2.3` and `1.2.3` are equivalent but `1.2.30` does not
 * satisfy `1.2.3`.
 * @param exec - Exec dependency from {@link StrategyDependencies}
 * @param installPath - Absolute directory where the binary was installed
 * @param versionCommand - Command and arguments declared on the client definition
 * @param expectedVersion - The version string that the binary must report
 * @throws When the command path is absolute or contains `..`
 * @throws When the command fails to execute
 * @throws When the command output does not contain the expected version token
 */
export async function verifyInstalledVersion(
  exec: StrategyDependencies['exec'],
  installPath: string,
  versionCommand: readonly [string, ...string[]],
  expectedVersion: string,
): Promise<void> {
  const [commandRelative, ...args] = versionCommand;

  // Security: reject absolute paths so the verifier cannot be used to run
  // arbitrary system binaries outside the install directory. Windows path
  // forms are rejected explicitly because client definitions are portable and
  // may be validated on a different host OS than the one executing them.
  if (isAbsolutePortablePath(commandRelative)) {
    throw new Error(`versionCommand[0] must be a relative path; received absolute path "${commandRelative}"`);
  }

  // Security: reject path traversal sequences before normalization so benign
  // looking strings such as `bin/../tool` do not depend on path collapse rules.
  if (commandRelative.split(/[/\\]/).includes('..')) {
    throw new Error(`versionCommand[0] must not contain path traversal segments; received "${commandRelative}"`);
  }

  const normalizedRelative = path.normalize(commandRelative);
  const resolvedCommand = path.join(installPath, normalizedRelative);
  const realInstallPath = await fs.realpath(installPath);
  const realCommandPath = await fs.realpath(resolvedCommand);
  if (!isPathWithinBase(realInstallPath, realCommandPath)) {
    throw new Error(
      `versionCommand[0] must not escape the install directory; "${commandRelative}" resolves outside installPath`,
    );
  }

  let stdout: string;
  try {
    stdout = await exec(realCommandPath, args, { cwd: realInstallPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Version verification failed: command "${resolvedCommand}" exited with an error: ${message}`, {
      cause: err,
    });
  }

  const normalizedExpected = stripLeadingV(expectedVersion);
  if (!containsVersionToken(stdout, normalizedExpected)) {
    throw new Error(`Version mismatch: expected "${expectedVersion}" but command output was "${stdout.trim()}"`);
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Strip a single leading `v` from a version string for semver-style
 * comparison. The prefix match is case-insensitive.
 *
 * `v1.2.3` → `1.2.3`, `1.2.3` → `1.2.3`, `version1.2.3` → `version1.2.3`.
 * @param version - Raw version string, possibly prefixed with `v`
 * @returns Version string with a leading `v` removed if present
 */
function stripLeadingV(version: string): string {
  return version[0] === 'v' || version[0] === 'V' ? version.slice(1) : version;
}

/**
 * Return `true` for POSIX, Windows drive-letter, rooted, or UNC absolute
 * paths regardless of the host OS running this validation.
 * @param value - Candidate executable path from `versionCommand[0]`
 * @returns `true` when the value is absolute on a supported host path syntax
 */
function isAbsolutePortablePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\');
}

/**
 * Return true when command output contains the expected version as a discrete
 * token, after normalizing a single leading `v` from each candidate token.
 * @param output - Raw stdout from the version command
 * @param normalizedExpected - Expected version with any leading `v` removed
 * @returns True when a matching version token is present
 */
function containsVersionToken(output: string, normalizedExpected: string): boolean {
  const tokens = output.match(/[A-Za-z0-9][A-Za-z0-9._+-]*/g) ?? [];
  return tokens.some((token) => stripLeadingV(token) === normalizedExpected);
}
