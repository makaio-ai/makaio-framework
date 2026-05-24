/**
 * Git merge command.
 * @packageDocumentation
 */

import { GitResponseError } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import type { MergeResult as MergeCommandResult, MergeOptions } from './types.js';

/**
 * Build git merge args with options before branch (git merge [options] <branch>).
 * @param branch - Branch to merge
 * @param options - Optional merge configuration
 * @returns Merge command args
 */
function buildMergeArgs(branch: string, options?: MergeOptions): string[] {
  const args: string[] = [];
  if (options?.squash) {
    args.push('--squash');
  }
  if (options?.noFf) {
    args.push('--no-ff');
  }
  if (options?.ffOnly) {
    args.push('--ff-only');
  }
  if (options?.strategy) {
    args.push('-s', options.strategy);
  }
  if (options?.message) {
    args.push('-m', options.message);
  }
  args.push(branch);
  return args;
}

/**
 * Map simple-git merge conflict errors to a structured merge result.
 * @param err - Thrown error
 * @returns Conflict result when applicable, otherwise undefined
 */
function mapMergeConflictError(err: unknown): MergeCommandResult | undefined {
  if (!(err instanceof GitResponseError) || !err.git) {
    return undefined;
  }
  const mergeDetail = err.git as { conflicts?: Array<{ file: string | null }>; failed?: boolean };
  if (!mergeDetail.failed || !mergeDetail.conflicts) {
    return undefined;
  }
  return {
    success: false,
    conflicts: mergeDetail.conflicts.map((c) => c.file).filter((f): f is string => f !== null),
    error: 'Merge conflicts detected',
  };
}

/**
 * Merge a branch into the current branch.
 * @param git - SimpleGit instance
 * @param branch - Branch name to merge
 * @param options - Optional merge configuration
 * @returns Merge result with conflict info if applicable
 */
export async function mergeBranch(git: SimpleGit, branch: string, options?: MergeOptions): Promise<MergeCommandResult> {
  try {
    const result = await git.merge(buildMergeArgs(branch, options));

    // Squash merges stage changes but don't create a commit
    if (options?.squash) {
      return {
        success: true,
        fastForward: false,
      };
    }

    const fastForward = options?.noFf ? false : result.merges.length === 0 && !result.failed;

    return {
      success: true,
      mergeCommit: fastForward ? undefined : (await git.revparse(['HEAD'])).trim(),
      fastForward,
    };
  } catch (err) {
    const conflictResult = mapMergeConflictError(err);
    if (conflictResult) {
      return conflictResult;
    }

    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to merge',
    };
  }
}

/**
 * Abort an in-progress merge.
 * @param git - SimpleGit instance
 * @returns Result indicating success
 */
export async function abortMerge(git: SimpleGit): Promise<MergeCommandResult> {
  try {
    await git.raw(['merge', '--abort']);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to abort merge',
    };
  }
}
