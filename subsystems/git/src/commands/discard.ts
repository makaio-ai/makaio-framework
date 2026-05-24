/**
 * Git discard changes command.
 * @packageDocumentation
 */

import type { SimpleGit } from 'simple-git';
import type { GitCommandResult } from './types.js';

/**
 * Discard working tree changes for specific files.
 *
 * Restores files to their state at HEAD. Does not affect staged changes.
 * @param git - SimpleGit instance
 * @param paths - File paths to discard changes for (relative to repo root)
 * @returns Result indicating success or failure
 */
export async function discardChanges(git: SimpleGit, paths: string[]): Promise<GitCommandResult> {
  if (paths.length === 0) {
    return { success: false, error: 'No paths provided' };
  }

  try {
    await git.raw(['checkout', '--', ...paths]);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to discard changes',
    };
  }
}
