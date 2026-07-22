/**
 * Version validation for the agent-client probe harness.
 *
 * Ensures that the installed CLI binary reports exactly the pinned
 * `managedInstall.version` from the client definition before any
 * networked model request is made.
 * @packageDocumentation
 */
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { ProviderId } from './types.js';

const execFileAsync = promisify(execFile);
const VERSION_COMMAND_TIMEOUT_MS = 15_000;

/**
 * Resolves the platform-specific executable path from a version command descriptor.
 * @param executable - The executable descriptor from the client definition.
 *   Either a plain string or an object with platform keys and a `default` fallback.
 * @returns The resolved executable name/path for the current platform.
 */
export function resolveExecutable(
  executable: string | { default: string; win32?: string; darwin?: string; linux?: string },
): string {
  if (typeof executable === 'string') return executable;
  const platformKey = process.platform as 'win32' | 'darwin' | 'linux';
  return executable[platformKey] ?? executable.default;
}

/**
 * Regex that matches a semver-shaped version token — major.minor.patch.
 * Accepts an optional `v` prefix (e.g. `v2.1.143`). Anchored so it does
 * not match substrings of longer numeric sequences: the version must be
 * preceded by start-of-string, whitespace, or `v`/`V`, and followed by
 * end-of-string or whitespace.
 */
const SEMVER_REGEX = /(?:^|(?<=\s))v?(\d+\.\d+\.\d+)(?=$|\s)/i;

/**
 * Extracts the exact semver version string from CLI version output.
 *
 * Many CLI binaries print prose around the version (e.g. `"claude v2.1.143"`)
 * so this function isolates the `major.minor.patch` token. Only the first
 * match is returned.
 * @param output - The trimmed stdout from the version command.
 * @returns The extracted version string, or the full output if no semver token is found.
 */
export function extractExactVersion(output: string): string {
  const match = SEMVER_REGEX.exec(output);
  return match?.[1] ?? output;
}

/**
 * Result of a version validation check.
 */
export interface VersionValidationResult {
  /** Whether the installed version matches the pinned version exactly. */
  readonly valid: boolean;
  /** The version string reported by the binary, or `undefined` on failure. */
  readonly reportedVersion?: string;
  /** The pinned version from the client definition. */
  readonly pinnedVersion: string;
  /** Error message if validation failed. */
  readonly error?: string;
}

/**
 * Validates that the CLI binary at the given base path reports exactly the
 * pinned `managedInstall.version`.
 * @param params - Validation parameters.
 * @param params.provider - The provider being validated.
 * @param params.pinnedVersion - The exact version from `managedInstall.version`.
 * @param params.executable - The executable descriptor from the client definition.
 * @param params.versionArgs - Arguments to pass for version output (e.g. `['--version']`).
 * @param params.basePath - Base directory for resolving relative executable paths (e.g. npm install dir).
 * @returns The validation result.
 */
export async function validateBinaryVersion(params: {
  provider: ProviderId;
  pinnedVersion: string;
  executable: string | { default: string; win32?: string; darwin?: string; linux?: string };
  versionArgs: readonly string[];
  basePath?: string;
}): Promise<VersionValidationResult> {
  const { pinnedVersion, executable, versionArgs, basePath } = params;
  const resolvedExecutable = resolveExecutable(executable);
  const fullPath = basePath ? path.join(basePath, resolvedExecutable) : resolvedExecutable;

  try {
    const { stdout } = await execFileAsync(fullPath, [...versionArgs], {
      timeout: VERSION_COMMAND_TIMEOUT_MS,
    });
    const trimmed = stdout.trim();
    const extractedVersion = extractExactVersion(trimmed);
    if (extractedVersion !== pinnedVersion) {
      return {
        valid: false,
        reportedVersion: trimmed,
        pinnedVersion,
        error: `Binary reports "${trimmed}" but pinned version is "${pinnedVersion}"`,
      };
    }
    return {
      valid: true,
      reportedVersion: trimmed,
      pinnedVersion,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      pinnedVersion,
      error: `Failed to run version command at "${fullPath}": ${message}`,
    };
  }
}
