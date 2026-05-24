import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import picomatch from 'picomatch';
import type { GitFingerprintResponse } from './schemas.js';

/**
 * Result of fingerprint computation.
 */
export type FingerprintComputeResult = GitFingerprintResponse;

type PathMatcher = (filePath: string) => boolean;
const NO_COMMIT_SHA = '0'.repeat(40);

/**
 * Compile glob patterns into reusable matcher functions.
 * @param patterns - Glob patterns
 * @returns Matchers configured with dot-file support
 */
function compileMatchers(patterns: string[]): PathMatcher[] {
  return patterns.map((pattern) => picomatch(pattern, { dot: true }));
}

/**
 * Check if a file path matches any of the given glob patterns.
 * @param filePath - File path to check (relative to repo root)
 * @param matchers - Precompiled glob matchers
 * @returns True if the path matches any pattern
 */
function matchesGlobs(filePath: string, matchers: PathMatcher[]): boolean {
  return matchers.some((matcher) => matcher(filePath));
}

/**
 * Filter file paths by include/exclude globs.
 * @param paths - File paths to filter
 * @param includeMatchers - Glob matchers to include
 * @param excludeMatchers - Glob matchers to exclude
 * @returns Filtered file paths
 */
function filterPaths(paths: string[], includeMatchers: PathMatcher[], excludeMatchers: PathMatcher[]): string[] {
  return paths.filter((p) => matchesGlobs(p, includeMatchers) && !matchesGlobs(p, excludeMatchers));
}

/**
 * Compute a content-aware fingerprint of repository state.
 *
 * The hash is derived from three sources, all filtered by include/exclude globs:
 * 1. Current commit SHA (anchors to commit)
 * 2. `git diff HEAD` filtered to matching paths (tracked changes: staged + unstaged)
 * 3. SHA-256 of each untracked file matching the globs
 * @param repoPath - Absolute path to the repository root
 * @param include - Glob patterns to include in fingerprint. Empty means "all files" (`['**']`).
 * @param exclude - Glob patterns to exclude from fingerprint
 * @param worktree - Optional git worktree path
 * @returns Fingerprint result with hash, commit SHA, changed paths, and timestamp
 */
export async function computeFingerprint(
  repoPath: string,
  include: string[],
  exclude: string[],
  worktree?: string,
): Promise<FingerprintComputeResult> {
  const gitPath = worktree ?? repoPath;
  const git = simpleGit(gitPath);
  // Empty include is treated as "match all" to avoid silently hashing only commit SHA.
  const includeMatchers = compileMatchers(include.length > 0 ? include : ['**']);
  const excludeMatchers = compileMatchers(exclude);

  // 1. Resolve HEAD; brand-new repos have no commits and must not throw.
  let commitSha = NO_COMMIT_SHA;
  let hasHeadCommit = true;
  try {
    commitSha = (await git.revparse(['HEAD'])).trim();
  } catch {
    hasHeadCommit = false;
  }

  // 2. Get tracked changed files (commit-aware): compare against HEAD when present,
  // otherwise compare index/worktree against the empty tree.
  const trackedFilesFromHead = hasHeadCommit ? (await git.raw(['diff', 'HEAD', '--name-only'])).trim().split('\n') : [];
  const trackedFilesNoHead = hasHeadCommit
    ? []
    : [
        ...(await git.raw(['diff', '--name-only'])).trim().split('\n'),
        ...(await git.raw(['diff', '--cached', '--name-only'])).trim().split('\n'),
      ];
  const trackedChangedFiles = Array.from(new Set([...trackedFilesFromHead, ...trackedFilesNoHead].filter(Boolean)));
  const filteredTrackedFiles = filterPaths(trackedChangedFiles, includeMatchers, excludeMatchers).sort();

  // Get the actual diff content only for matching files
  let filteredDiff = '';
  if (hasHeadCommit && filteredTrackedFiles.length > 0) {
    filteredDiff = await git.raw(['diff', 'HEAD', '--', ...filteredTrackedFiles]);
  } else if (!hasHeadCommit && filteredTrackedFiles.length > 0) {
    const workingTreeDiff = await git.raw(['diff', '--', ...filteredTrackedFiles]);
    const stagedDiff = await git.raw(['diff', '--cached', '--', ...filteredTrackedFiles]);
    filteredDiff = `${workingTreeDiff}\n${stagedDiff}`;
  }

  // 3. Get untracked files and filter by globs
  const untrackedRaw = await git.raw(['ls-files', '--others', '--exclude-standard']);
  const untrackedFiles = untrackedRaw.trim().split('\n').filter(Boolean);
  const filteredUntrackedFiles = filterPaths(untrackedFiles, includeMatchers, excludeMatchers).sort();

  // Hash untracked files in parallel. allSettled keeps per-file fault tolerance.
  const untrackedHashResults = await Promise.allSettled(
    filteredUntrackedFiles.map(async (file) => {
      const content = await readFile(path.join(gitPath, file));
      const fileHash = createHash('sha256').update(content).digest('hex');
      return `${file}:${fileHash}`;
    }),
  );
  const untrackedHashes = untrackedHashResults
    .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
    .map((result) => result.value);

  // Combine all changed paths (deduped, sorted)
  const changedPaths = Array.from(new Set([...filteredTrackedFiles, ...filteredUntrackedFiles])).sort();

  // 4. Compute final hash from commit SHA, filtered diff, and untracked hashes
  const hashInput = [commitSha, filteredDiff, ...untrackedHashes].join('\n');
  const hash = createHash('sha256').update(hashInput).digest('hex');

  return {
    hash,
    commitSha,
    changedPaths,
    timestamp: new Date().toISOString(),
  };
}
