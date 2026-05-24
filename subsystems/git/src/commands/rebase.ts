/**
 * Git rebase command with auto-stash composable.
 * @packageDocumentation
 */

import type { SimpleGit } from 'simple-git';
import type { RebaseResult, RebaseOptions } from './types.js';

/**
 * Check if the working tree has uncommitted changes.
 * @param git - SimpleGit instance
 * @returns True if the working tree is dirty
 */
async function isDirty(git: SimpleGit): Promise<boolean> {
  const status = await git.status();
  return !status.isClean();
}

/**
 * Rebase the current branch onto a target.
 *
 * When `options.autoStash` is true, the function will:
 * 1. Check for dirty working tree
 * 2. Auto-stash if dirty
 * 3. Execute rebase
 * 4. Pop stash on success (leave stashed on failure with clear messaging)
 * @param git - SimpleGit instance
 * @param onto - Target branch or commit to rebase onto
 * @param options - Optional rebase configuration
 * @returns Rebase result with stash info
 */
export async function rebase(git: SimpleGit, onto: string, options?: RebaseOptions): Promise<RebaseResult> {
  // Handle in-progress rebase actions (continue, abort, skip)
  if (options?.action) {
    return handleRebaseAction(git, options.action);
  }

  let autoStashed = false;

  try {
    // Auto-stash if requested and working tree is dirty
    if (options?.autoStash) {
      const dirty = await isDirty(git);
      if (dirty) {
        // Include untracked files so the working tree is fully clean before checkout/rebase.
        await git.raw(['stash', 'push', '--include-untracked', '-m', `auto-stash before rebase onto ${onto}`]);
        autoStashed = true;
      }
    }

    await git.raw(['rebase', onto]);

    // Pop stash on success
    let stashPopped = false;
    if (autoStashed) {
      try {
        await git.raw(['stash', 'pop']);
        stashPopped = true;
      } catch {
        // Non-fatal post-step: rebase itself succeeded, but re-applying stashed changes did not.
        // We keep success=true and surface guidance via error to avoid changing the shared result contract.
        return {
          success: true,
          autoStashed,
          stashPopped: false,
          error: 'Rebase succeeded but stash pop failed. Your changes are in stash@{0}.',
        };
      }
    }

    return {
      success: true,
      autoStashed,
      stashPopped,
    };
  } catch (err) {
    // Detect rebase conflicts from git output
    const errorMessage = err instanceof Error ? err.message : 'Failed to rebase';
    const hasConflicts = errorMessage.includes('CONFLICT') || errorMessage.includes('could not apply');

    const conflicts = hasConflicts ? await getConflictedFiles(git) : undefined;

    return {
      success: false,
      autoStashed,
      stashPopped: false,
      conflicts,
      error: autoStashed
        ? `${errorMessage}. Your pre-rebase changes are saved in stash. Resolve conflicts and run rebase --continue, then stash pop.`
        : errorMessage,
    };
  }
}

/**
 * Handle rebase --continue, --abort, or --skip.
 * @param git - SimpleGit instance
 * @param action - The rebase action to take
 * @returns Rebase result
 */
async function handleRebaseAction(git: SimpleGit, action: 'continue' | 'abort' | 'skip'): Promise<RebaseResult> {
  try {
    await git.raw(['rebase', `--${action}`]);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : `Failed to rebase --${action}`,
    };
  }
}

/**
 * Get list of conflicted files from git status.
 * @param git - SimpleGit instance
 * @returns Array of conflicted file paths
 */
async function getConflictedFiles(git: SimpleGit): Promise<string[]> {
  try {
    const status = await git.status();
    return status.conflicted;
  } catch {
    return [];
  }
}
