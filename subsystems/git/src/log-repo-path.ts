import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import { resolveInvalidationRoot } from './invalidation-root.js';

/**
 * Resolve the repository path used for git log queries.
 * @param repoPath - Base repository path from the request
 * @param selectedWorktree - Optional selected worktree path
 * @returns Path to use for git log queries
 * @throws Error when selectedWorktree is not part of the same repository
 */
export async function resolveLogRepoPath(repoPath: string, selectedWorktree?: string): Promise<string> {
  if (!selectedWorktree) {
    return repoPath;
  }

  const [repoIdentity, worktreeIdentity] = await Promise.all([
    resolveRepositoryIdentity(repoPath),
    resolveRepositoryIdentity(selectedWorktree),
  ]);

  if (repoIdentity !== worktreeIdentity) {
    throw new Error('selectedWorktree must belong to the same repository as repoPath');
  }

  // Return a canonical path so equivalent spellings (e.g. "..", symlinked roots)
  // map to the same downstream git invocation and cache key.
  return normalizePath(selectedWorktree);
}

/**
 * Resolve repository identity across main repos and linked worktrees.
 * Falls back progressively for compatibility with older git versions.
 * @param repoPath - Repository or worktree path
 * @returns Stable identity for same-repository comparisons
 */
async function resolveRepositoryIdentity(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);

  try {
    // Newer git versions support absolute common-dir output directly.
    const commonDir = (await git.revparse(['--path-format=absolute', '--git-common-dir'])).trim();
    return normalizePath(commonDir);
  } catch {
    // Fall through to legacy flags for compatibility with older git versions.
  }

  try {
    // Fallback for older git: resolve relative common-dir against cwd repo path.
    const commonDir = (await git.revparse(['--git-common-dir'])).trim();
    return normalizePath(toAbsolutePath(commonDir, repoPath));
  } catch {
    // Fall through to absolute git dir fallback.
  }

  try {
    // Last git-level fallback: derive common dir from absolute git dir.
    const absoluteGitDir = (await git.revparse(['--absolute-git-dir'])).trim();
    return normalizePath(toCommonDirFromAbsoluteGitDir(absoluteGitDir));
  } catch {
    // Fall through to non-git fallback below.
  }

  // Final fallback when rev-parse variants are unavailable or fail.
  return normalizePath(await resolveInvalidationRoot(repoPath));
}

/**
 * Convert potentially relative path output from git to absolute path.
 * @param targetPath - Path reported by git
 * @param cwdPath - Working directory used for the git call
 * @returns Absolute path for the git-reported target
 */
function toAbsolutePath(targetPath: string, cwdPath: string): string {
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }
  return path.resolve(cwdPath, targetPath);
}

/**
 * Collapse worktree-specific absolute git dir to repository common dir.
 * @param absoluteGitDir - Absolute path from `git rev-parse --absolute-git-dir`
 * @returns Path representing the repository common git directory
 */
function toCommonDirFromAbsoluteGitDir(absoluteGitDir: string): string {
  const gitWorktreesSegment = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  // Only collapse git's internal ".git/worktrees/" suffix. Parent directories
  // may also include "worktrees" and must not affect repository identity.
  const gitWorktreesIndex = absoluteGitDir.lastIndexOf(gitWorktreesSegment);
  if (gitWorktreesIndex === -1) {
    return absoluteGitDir;
  }
  return absoluteGitDir.slice(0, gitWorktreesIndex + `${path.sep}.git`.length);
}

/**
 * Normalize a path for robust equality checks.
 * @param targetPath - Path to normalize
 * @returns Canonical path when resolvable, otherwise original path
 */
async function normalizePath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return targetPath;
  }
}
