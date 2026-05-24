/**
 * Basic git query functions.
 * @packageDocumentation
 */

import { simpleGit, type SimpleGit } from 'simple-git';
import type { GitBranchResponse, GitCommitResponse, GitRepoRootResponse } from '../schemas.js';

/**
 * Get a simple-git instance for the given repo path.
 * @param repoPath - Optional repository path, defaults to cwd
 * @returns SimpleGit instance
 */
export function getGit(repoPath?: string): SimpleGit {
  return simpleGit(repoPath ?? process.cwd());
}

/**
 * Get repository root directory from any path within the repo.
 * Uses `git rev-parse --show-toplevel` to resolve the root.
 * @param path - Any path within the repository
 * @returns Repository root path, or null if path is not inside a git repository
 */
export async function getRepoRoot(path: string): Promise<GitRepoRootResponse> {
  try {
    const git = simpleGit(path);
    const root = (await git.revparse(['--show-toplevel'])).trim();
    return { root };
  } catch {
    return { root: null };
  }
}

/**
 * Get current branch info.
 * @param git - SimpleGit instance
 * @returns Branch info
 */
export async function getBranch(git: SimpleGit): Promise<GitBranchResponse> {
  const status = await git.status();
  return { current: status.current ?? '', isDetached: status.detached };
}

/**
 * Get commit info for a ref.
 * @param git - SimpleGit instance
 * @param ref - Git ref, defaults to HEAD
 * @returns Commit info
 */
export async function getCommit(git: SimpleGit, ref?: string): Promise<GitCommitResponse> {
  const log = await git.log([ref ?? 'HEAD', '-1']);
  const latest = log.latest;
  if (!latest) throw new Error('No commits found');
  return {
    hash: latest.hash,
    message: latest.message,
    author: latest.author_name,
    email: latest.author_email,
    date: latest.date,
  };
}
