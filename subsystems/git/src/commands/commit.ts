/**
 * Git commit command.
 * @packageDocumentation
 */

import type { SimpleGit } from 'simple-git';
import type { CommitResult, CommitOptions } from './types.js';

/**
 * Create a git commit with the staged changes.
 * @param git - SimpleGit instance
 * @param message - Commit message
 * @param options - Optional commit configuration
 * @returns Commit result with hash on success
 */
export async function commitChanges(git: SimpleGit, message: string, options?: CommitOptions): Promise<CommitResult> {
  try {
    const args: string[] = ['commit', '-m', message];

    if (options?.amend) {
      args.push('--amend');
    }
    if (options?.allowEmpty) {
      args.push('--allow-empty');
    }
    if (options?.author) {
      args.push(`--author=${options.author}`);
    }

    await git.raw(args);

    const hash = (await git.revparse(['HEAD'])).trim();

    return {
      success: true,
      hash,
      message,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to create commit',
    };
  }
}
