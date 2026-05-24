/**
 * Git worktree management queries.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { GitCreateWorktreeResponse, GitRemoveWorktreeResponse, GitWorktreesResponse } from '../schemas.js';

/**
 * Get list of worktrees.
 * @param git - SimpleGit instance
 * @returns Worktree list
 */
export async function getWorktrees(git: SimpleGit): Promise<GitWorktreesResponse> {
  const result = await git.raw(['worktree', 'list', '--porcelain']);
  const worktrees: GitWorktreesResponse['worktrees'] = [];

  let currentPath: string | undefined;
  let currentCommit: string | undefined;
  let currentBranch: string | undefined;

  const pushWorktree = () => {
    if (currentPath) {
      const isMain = worktrees.length === 0;
      worktrees.push({
        path: currentPath,
        branch: currentBranch ?? '(detached)',
        commit: currentCommit ?? '',
        isMain,
      });
    }
  };

  for (const line of result.split('\n')) {
    if (line.startsWith('worktree ')) {
      pushWorktree();
      currentPath = line.slice(9);
      currentCommit = undefined;
      currentBranch = undefined;
    } else if (line.startsWith('HEAD ')) {
      currentCommit = line.slice(5);
    } else if (line.startsWith('branch ')) {
      currentBranch = line.slice(7).replace('refs/heads/', '');
    }
  }

  pushWorktree();
  return { worktrees };
}

/**
 * Initialize a new git repository with atomic --initial-branch.
 * @param dirPath - Directory to initialize
 * @param defaultBranch - Default branch name
 * @returns Result with success status
 */
export async function initRepo(
  dirPath: string,
  defaultBranch: string = 'main',
): Promise<{ success: boolean; path: string; defaultBranch: string }> {
  const git = simpleGit(dirPath);

  // Use --initial-branch for atomic init (no race between init and branch creation)
  await git.init(['--initial-branch', defaultBranch]);

  return {
    success: true,
    path: dirPath,
    defaultBranch,
  };
}

/**
 * Create a new git worktree at the specified path.
 * @param git - SimpleGit instance
 * @param worktreePath - Worktree path
 * @param branch - Branch name
 * @param options - Branch creation options
 * @returns Result with success status
 */
export async function createWorktree(
  git: SimpleGit,
  worktreePath: string,
  branch: string,
  options?: { baseBranch?: string; createBranch?: boolean },
): Promise<GitCreateWorktreeResponse> {
  try {
    const args = ['worktree', 'add'];

    if (options?.createBranch) {
      // Create new branch: git worktree add -b <branch> <path> [<base>]
      args.push('-b', branch, worktreePath);
      if (options.baseBranch) {
        args.push(options.baseBranch);
      }
    } else {
      // Checkout existing branch: git worktree add <path> <branch>
      args.push(worktreePath, branch);
    }

    await git.raw(args);

    return {
      success: true,
      path: worktreePath,
      branch,
    };
  } catch (err) {
    return {
      success: false,
      path: worktreePath,
      branch,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Remove a git worktree.
 * @param git - SimpleGit instance
 * @param worktreePath - Worktree path
 * @param options - Force and branch deletion options
 * @returns Result with success status
 */
export async function removeWorktree(
  git: SimpleGit,
  worktreePath: string,
  options?: { force?: boolean; deleteBranch?: boolean },
): Promise<GitRemoveWorktreeResponse> {
  try {
    // Get branch name before removing (needed for deleteBranch)
    let branchToDelete: string | undefined;
    if (options?.deleteBranch) {
      const worktrees = await getWorktrees(git);
      // Normalize path to handle symlinks (e.g., macOS /var -> /private/var)
      const normalizedPath = await fs.realpath(worktreePath).catch(() => worktreePath);
      const worktree = worktrees.worktrees.find((w) => w.path === normalizedPath);
      if (worktree && worktree.branch !== '(detached)') {
        branchToDelete = worktree.branch;
      }
    }

    // Remove the worktree
    const args = ['worktree', 'remove'];
    if (options?.force) {
      args.push('--force');
    }
    args.push(worktreePath);

    await git.raw(args);

    // Delete branch if requested
    if (branchToDelete) {
      await git.branch(['-D', branchToDelete]);
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
