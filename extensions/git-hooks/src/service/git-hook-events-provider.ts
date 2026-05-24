/**
 * Native git hook coverage provider.
 *
 * Answers `GitHookSubjects.coverage` queries by reading the install state
 * written by the installer. Registered with the capability bus by
 * `GitHookTranslatorService` at startup and unregistered at teardown.
 * @packageDocumentation
 */

import type { IGitHookEventsProvider, GitHookCoverageRequest, GitHookCoverageResponse } from '@makaio/contracts';
import { GIT_HOOK_EVENTS_CAPABILITY_ID } from '@makaio/contracts';
import { readGitHookStatus } from '../install/status.js';

/**
 * Capability provider that reports native git hook coverage for a repository.
 *
 * A single instance is registered per extension activation. Coverage is
 * computed on demand by reading the installer's state file, so the response
 * always reflects current disk state rather than stale in-memory data.
 */
export class GitHookEventsProvider implements IGitHookEventsProvider {
  public readonly id = 'git-hooks-extension';
  public readonly displayName = 'Native Git Hooks';
  public readonly capabilityId = GIT_HOOK_EVENTS_CAPABILITY_ID;

  /**
   * Query whether native git hooks cover the requested repository and operation.
   *
   * If the requested operation is not in the set of covered operations
   * returned by the install state, the response is `covered: false` with
   * reason `unsupported-operation` and the full covered set for diagnostics.
   * @param request - Coverage query specifying repo path and git operation.
   * @returns Coverage response indicating whether native hooks cover the operation.
   */
  public async getCoverage(request: GitHookCoverageRequest): Promise<GitHookCoverageResponse> {
    const status = await readGitHookStatus(request.repoPath);
    if (!status.covered) {
      return status;
    }
    if (!status.coveredOperations.includes(request.operation)) {
      return {
        covered: false,
        reason: 'unsupported-operation',
        coveredOperations: status.coveredOperations,
      };
    }
    return status;
  }
}
