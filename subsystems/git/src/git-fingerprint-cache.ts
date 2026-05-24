import type { GitFingerprintRequest, GitFingerprintResponse } from './schemas.js';
import { GitCacheBase } from './git-cache-base.js';

/**
 * Cache for git fingerprint computation results.
 *
 * Cache key includes the repo path and sorted include/exclude globs
 * to prevent cache fragmentation from array ordering differences.
 *
 * Dual invalidation: invalidated by both git semantic events
 * (commit, checkout, staging, merge, rebase) AND fs.batch events
 * (source file edits on disk).
 */
export class GitFingerprintCache extends GitCacheBase<GitFingerprintRequest, GitFingerprintResponse> {
  /**
   * Build a cache key from a fingerprint request and repository path.
   * @param request - The git fingerprint request
   * @param repoPath - Repository path for keying
   * @returns JSON string cache key
   */
  protected buildKey(request: GitFingerprintRequest, repoPath: string): string {
    return JSON.stringify({
      repoPath,
      include: request.include.slice().sort(),
      exclude: request.exclude.slice().sort(),
      worktree: request.worktree,
    });
  }
}
