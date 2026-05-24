/**
 * Git refs queries.
 * @packageDocumentation
 */

import type { SimpleGit } from 'simple-git';
import type { GitRefs } from '../schemas.js';

/**
 * Get all refs in the repository.
 * @param git - SimpleGit instance
 * @returns All refs (branches, remotes, tags, HEAD)
 */
export async function getRefs(git: SimpleGit): Promise<GitRefs> {
  const [localBranches, remoteBranches, tags, headRef] = await Promise.all([
    git.branchLocal(),
    git.branch(['-r', '--format=%(refname:short) %(objectname)']),
    git.tags(),
    git.revparse(['HEAD']),
  ]);

  // Get full commit hashes for local branches (branchLocal returns short hashes)
  const branches: Record<string, string> = {};
  await Promise.all(
    localBranches.all.map(async (name) => {
      try {
        const fullHash = (await git.revparse([`refs/heads/${name}`])).trim();
        branches[name] = fullHash;
      } catch {
        /* Skip unresolvable branches */
      }
    }),
  );

  const remotes: Record<string, string> = {};
  for (const name of remoteBranches.all) {
    const branch = remoteBranches.branches[name];
    if (branch) {
      remotes[name] = branch.commit;
    }
  }

  const tagRefs: Record<string, string> = {};
  for (const tagName of tags.all) {
    try {
      tagRefs[tagName] = (await git.revparse([tagName])).trim();
    } catch {
      /* Skip unresolvable tags */
    }
  }

  return {
    branches,
    remoteBranches: remotes,
    tags: tagRefs,
    HEAD: headRef.trim(),
  };
}

/**
 * Get all commit hashes reachable from a branch.
 * Used for ancestry checking in fade logic.
 * @param git - SimpleGit instance
 * @param branchName - Branch name to get commits for
 * @returns Array of commit hashes (full SHA)
 */
export async function getBranchCommits(git: SimpleGit, branchName: string): Promise<string[]> {
  try {
    const output = await git.raw(['log', branchName, '--format=%H']);
    return output.trim().split('\n').filter(Boolean);
  } catch {
    // Branch doesn't exist or other error
    return [];
  }
}
