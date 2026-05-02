import { readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type OpenCodeStorageSubDir = 'message' | 'part';

/**
 * Check whether a filesystem error represents a missing/non-directory path.
 * @param error - Unknown filesystem error
 * @returns True when the path should be treated as absent
 */
export function isMissingDirectoryError(error: unknown): boolean {
  const errorCode = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
  return errorCode === 'ENOENT' || errorCode === 'ENOTDIR';
}

/**
 * List JSON file names from an OpenCode storage directory.
 * @param storageRoot - Root storage directory containing message/session/part folders
 * @param subDir - Storage subdirectory (`message` or `part`)
 * @param id - Session ID for `message` or message ID for `part`
 * @returns JSON file names found in the target directory
 */
export function listJsonFileNames(storageRoot: string, subDir: OpenCodeStorageSubDir, id: string): string[] {
  return readdirSync(join(storageRoot, subDir, id), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name);
}

/**
 * Check whether an OpenCode storage directory contains any JSON files.
 * @param storageRoot - Root storage directory containing message/session/part folders
 * @param subDir - Storage subdirectory (`message` or `part`)
 * @param id - Session ID for `message` or message ID for `part`
 * @returns True when at least one JSON file exists
 */
export async function hasJsonFiles(storageRoot: string, subDir: OpenCodeStorageSubDir, id: string): Promise<boolean> {
  const entries = await readdir(join(storageRoot, subDir, id), { withFileTypes: true });
  return entries.some((entry) => entry.isFile() && entry.name.endsWith('.json'));
}
