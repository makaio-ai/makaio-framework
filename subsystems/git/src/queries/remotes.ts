/**
 * Git remotes and default branch queries.
 * @packageDocumentation
 */

import type { SimpleGit } from 'simple-git';
import type { GitDefaultBranchResponse, GitRemotesResponse } from '../schemas.js';

/**
 * Get list of remotes.
 * @param git - SimpleGit instance
 * @returns Remote list
 */
export async function getRemotes(git: SimpleGit): Promise<GitRemotesResponse> {
  const remotes = await git.getRemotes(true);
  return {
    remotes: remotes.map((r) => ({
      name: r.name,
      fetchUrl: r.refs.fetch ?? '',
      pushUrl: r.refs.push ?? r.refs.fetch ?? '',
    })),
  };
}

/**
 * Get repository default branch.
 * @param git - SimpleGit instance
 * @returns Default branch name
 */
export async function getDefaultBranch(git: SimpleGit): Promise<GitDefaultBranchResponse> {
  try {
    const result = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const branch = result.trim().replace('refs/remotes/origin/', '');
    return { branch };
  } catch {
    const branches = await git.branchLocal();
    if (branches.all.includes('main')) {
      return { branch: 'main' };
    }
    if (branches.all.includes('master')) {
      return { branch: 'master' };
    }
    return { branch: branches.current };
  }
}
