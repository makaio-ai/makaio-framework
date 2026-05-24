import type { GitLogRequest, GitLogResponse } from './schemas.js';
import { GitCacheBase } from './git-cache-base.js';

/**
 * Cache for git log query results.
 *
 * Extends {@link GitCacheBase} with a key strategy that normalizes
 * all log request parameters (filters, ref, limit, etc.) into a
 * stable JSON cache key.
 */
export class GitLogCache extends GitCacheBase<GitLogRequest, GitLogResponse> {
  /**
   * Build a cache key from a log request and repository path.
   * @param request - The git log request
   * @param repoPath - Repository path for keying
   * @returns JSON string cache key
   */
  protected buildKey(request: GitLogRequest, repoPath: string): string {
    const normalized = {
      repoPath,
      limit: request.limit,
      ref: request.ref,
      filters: request.filters
        ? {
            author: request.filters.author,
            baseBranch: request.filters.baseBranch,
            branchMode: request.filters.branchMode,
            branches: request.filters.branches?.slice().sort(),
            paths: request.filters.paths?.slice().sort(),
            searchQuery: request.filters.searchQuery,
            selectedWorktree: request.filters.selectedWorktree,
            since: request.filters.since,
            until: request.filters.until,
          }
        : undefined,
    };
    return JSON.stringify(normalized);
  }
}
