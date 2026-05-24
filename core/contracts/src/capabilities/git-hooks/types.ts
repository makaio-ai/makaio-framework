import type { ICapabilityProvider } from '../../capability/types.js';
import type { GitHookCoverageRequest, GitHookCoverageResponse } from './schemas.js';

/**
 * Capability provider interface for git hook event coverage.
 *
 * Implementations are registered by the git-hooks extension and answer
 * coverage queries from GitWatcher to determine whether native hook
 * installation is in place for a given repository and operation.
 */
export interface IGitHookEventsProvider extends ICapabilityProvider {
  /** Stable capability identifier for this provider type. */
  readonly capabilityId: 'git-hook-events';
  /**
   * Query whether native git hooks cover the requested repo and operation.
   * @param request - The coverage query specifying repo path and git operation.
   * @returns A response indicating coverage status, reason code, and all covered operations.
   */
  getCoverage(request: GitHookCoverageRequest): Promise<GitHookCoverageResponse>;
}
