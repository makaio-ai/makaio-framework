import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Narrow an unknown error to a Node.js errno exception.
 * @param error - Error to inspect.
 * @returns Whether the error has a string errno code.
 */
export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}

/**
 * Check whether an error represents a missing file or directory (ENOENT).
 * @param error - Error to inspect.
 * @returns Whether the path was not found.
 */
export function isMissingPathError(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOENT';
}

/**
 * Check whether an error represents a path that is not a directory (ENOTDIR).
 * @param error - Error to inspect.
 * @returns Whether the path exists but is not a directory.
 */
export function isNotDirectoryError(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOTDIR';
}

/**
 * Format an unknown error as a human-readable string.
 * @param error - Error to format.
 * @returns Human-readable error message.
 */
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Narrow an unknown value to a plain object record (non-null, non-array).
 * @param value - Value to inspect.
 * @returns Whether the value is a non-array object record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * List `.yaml` files in a directory.
 *
 * Returns an empty array when the directory does not exist (ENOENT) and throws
 * when the path exists but is not a directory (ENOTDIR).
 * @param dir - Directory to scan.
 * @returns Sorted absolute paths to `.yaml` files.
 * @throws Error when the path exists but is not a directory.
 */
export async function listYamlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir);
    return entries
      .filter((entry) => entry.endsWith('.yaml'))
      .sort()
      .map((entry) => path.join(dir, entry));
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    if (isNotDirectoryError(error)) {
      throw new Error(`Invalid model registry directory ${dir}: expected a directory.`, {
        cause: error,
      });
    }
    throw error;
  }
}
