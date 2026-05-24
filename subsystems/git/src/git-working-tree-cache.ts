import type { GitWorkingTreeDetailsRequest, GitWorkingTreeDetailsResponse } from './schemas.js';
import { GitCacheBase } from './git-cache-base.js';

/**
 * Cache for git working tree details results.
 *
 * Extends {@link GitCacheBase} with a simple key strategy based on
 * repository path only (working tree requests currently have no
 * additional filter parameters).
 */
export class GitWorkingTreeCache extends GitCacheBase<GitWorkingTreeDetailsRequest, GitWorkingTreeDetailsResponse> {
  /**
   * Build a cache key from request and repository path.
   * @param _request - The working tree details request (unused currently, reserved for future filtering)
   * @param repoPath - Repository path for keying
   * @returns JSON string cache key
   */
  protected buildKey(_request: GitWorkingTreeDetailsRequest, repoPath: string): string {
    return JSON.stringify({ repoPath });
  }
}
