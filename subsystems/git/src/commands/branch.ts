/**
 * Git branch commands (create, delete, rename).
 * @packageDocumentation
 */

import type { SimpleGit } from 'simple-git';
import type { CreateBranchResult, DeleteBranchResult, GitCommandResult } from './types.js';

/**
 * Create a new local branch.
 * @param git - SimpleGit instance
 * @param name - Branch name to create
 * @param startPoint - Starting ref (defaults to HEAD)
 * @returns Result with branch name on success
 */
export async function createBranch(git: SimpleGit, name: string, startPoint?: string): Promise<CreateBranchResult> {
  try {
    const args = ['branch', name];
    if (startPoint) {
      args.push(startPoint);
    }
    await git.raw(args);
    return { success: true, branch: name };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to create branch',
    };
  }
}

/**
 * Delete a local branch.
 * @param git - SimpleGit instance
 * @param name - Branch name to delete
 * @param force - Force delete even if not merged (uses -D instead of -d)
 * @returns Result with branch name on success
 */
export async function deleteBranch(git: SimpleGit, name: string, force?: boolean): Promise<DeleteBranchResult> {
  try {
    const flag = force ? '-D' : '-d';
    await git.raw(['branch', flag, name]);
    return { success: true, branch: name };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to delete branch',
    };
  }
}

/**
 * Rename a local branch.
 * @param git - SimpleGit instance
 * @param oldName - Current branch name
 * @param newName - New branch name
 * @returns Result indicating success or failure
 */
export async function renameBranch(git: SimpleGit, oldName: string, newName: string): Promise<GitCommandResult> {
  try {
    await git.raw(['branch', '-m', oldName, newName]);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to rename branch',
    };
  }
}
