/**
 * Git file operations (diff, stage, unstage).
 * @packageDocumentation
 */

import type { SimpleGit } from 'simple-git';
import type {
  GitBlobHashAtCommitResponse,
  GitDiffResponse,
  GitFileAtRevisionResponse,
  GitFileAtCommitResponse,
  GitStageResponse,
  GitUnstageResponse,
} from '../schemas.js';

/**
 * Check if content appears to be binary.
 * @param content - Content to check
 * @returns True if content appears binary
 */
function isBinaryContent(content: string): boolean {
  // Check for null bytes which indicate binary content
  return content.includes('\0');
}

/**
 * Filter out empty path entries.
 * @param paths - Paths to filter
 * @returns Non-empty paths
 */
function filterEmptyPaths(paths: string[]): string[] {
  return paths.filter((path) => path.length > 0);
}

/**
 * Get file content at a specific revision.
 * @param git - SimpleGit instance
 * @param filePath - File path
 * @param ref - Git ref
 * @returns File content and binary flag
 */
export async function getFileAtRevision(
  git: SimpleGit,
  filePath: string,
  ref: string,
): Promise<GitFileAtRevisionResponse> {
  const content = await git.show([`${ref}:${filePath}`]);
  const isBinary = isBinaryContent(content);
  return { content: isBinary ? '' : content, isBinary };
}

/**
 * Get file content at a specific commit, returning null when the file did not
 * exist at that commit instead of throwing.
 *
 * This is the null-safe companion to {@link getFileAtRevision}, designed for
 * divergence checks where a file being absent at the baseline commit is a valid
 * outcome (not an error).
 * @param git - SimpleGit instance
 * @param filePath - File path relative to repository root
 * @param commitHash - Full or abbreviated commit SHA
 * @returns File content and binary flag, or null content when file was not present
 */
export async function getFileAtCommit(
  git: SimpleGit,
  filePath: string,
  commitHash: string,
): Promise<GitFileAtCommitResponse> {
  try {
    const content = await git.show([`${commitHash}:${filePath}`]);
    const isBinary = isBinaryContent(content);
    return { content: isBinary ? null : content, isBinary };
  } catch {
    // File did not exist at this commit (or invalid commit/path)
    return { content: null, isBinary: false };
  }
}

/**
 * Get the git blob hash for a file at a specific commit using `git ls-tree`.
 *
 * Blob hash comparison is more efficient than full content comparison when
 * checking divergence — if the blob hash matches the current working tree
 * hash, the content is identical without reading either file.
 *
 * Returns null when the file did not exist at the commit, the commit is
 * invalid, or the repository is unreachable.
 * @param git - SimpleGit instance
 * @param filePath - File path relative to repository root
 * @param commitHash - Full or abbreviated commit SHA
 * @returns Blob hash string, or null if not found
 */
export async function getBlobHashAtCommit(
  git: SimpleGit,
  filePath: string,
  commitHash: string,
): Promise<GitBlobHashAtCommitResponse> {
  try {
    // Output format: "<mode> blob <hash>\t<filename>"
    const output = await git.raw(['ls-tree', commitHash, '--', filePath]);
    if (!output.trim()) {
      return { blobHash: null };
    }
    // Parse the blob hash from the third whitespace-delimited token
    const parts = output.trim().split(/\s+/);
    const blobHash = parts[2] ?? null;
    return { blobHash };
  } catch {
    return { blobHash: null };
  }
}

/**
 * Get unified diff for the working tree or a specific commit.
 * @param git - SimpleGit instance
 * @param ref - Git ref for commit diff (diffs ref^..ref)
 * @param staged - When true, diff against index (cached). Ignored if ref is provided.
 * @param unified - Unified context lines (0-10)
 * @param paths - Optional path filters
 * @returns Unified diff string
 */
export async function getDiff(
  git: SimpleGit,
  ref?: string,
  staged?: boolean,
  unified?: number,
  paths?: string[],
): Promise<GitDiffResponse> {
  const args: string[] = ['diff'];

  if (ref) {
    // Commit diff: show what the commit changed
    // Check if this is a root commit by checking parent count
    const parents = await git.raw(['rev-list', '--parents', '-n', '1', ref]);
    const isRootCommit = parents.trim().split(/\s+/).length === 1;

    if (isRootCommit) {
      // Root commit: show all files as additions (diff against empty tree)
      args.push('4b825dc642cb6eb9a060e54bf8d69288fbee4904', ref);
    } else {
      // Normal commit: show what changed from parent
      args.push(`${ref}^..${ref}`);
    }
  } else if (staged) {
    // Working tree: staged changes
    args.push('--cached');
  }
  // Otherwise: unstaged working tree changes

  if (typeof unified === 'number') args.push(`--unified=${unified}`);
  if (paths?.length) args.push('--', ...paths);
  const diff = await git.raw(args);
  return { diff };
}

/**
 * Stage files for commit.
 * @param git - SimpleGit instance
 * @param paths - File paths to stage (relative to repo root)
 * @returns Success/error result
 */
export async function stageFiles(git: SimpleGit, paths: string[]): Promise<GitStageResponse> {
  const filtered = filterEmptyPaths(paths);
  if (filtered.length === 0) {
    return { success: false, error: 'No paths provided' };
  }

  try {
    await git.add(filtered);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to stage files',
    };
  }
}

/**
 * Unstage files (remove from staging area).
 * @param git - SimpleGit instance
 * @param paths - File paths to unstage (relative to repo root)
 * @returns Success/error result
 */
export async function unstageFiles(git: SimpleGit, paths: string[]): Promise<GitUnstageResponse> {
  const filtered = filterEmptyPaths(paths);
  if (filtered.length === 0) {
    return { success: false, error: 'No paths provided' };
  }

  try {
    await git.reset(['HEAD', '--', ...filtered]);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to unstage files',
    };
  }
}
