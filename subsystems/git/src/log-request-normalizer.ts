import type { GitLogRequest } from './schemas.js';

/**
 * Normalize log request fields that participate in cache key generation.
 * @param request - Incoming getLog request
 * @param normalizedWorktreePath - Canonical selected worktree path
 * @returns Request with normalized selectedWorktree when present
 */
export function normalizeLogRequest(request: GitLogRequest, normalizedWorktreePath: string): GitLogRequest {
  if (!request.filters?.selectedWorktree) {
    return request;
  }

  return {
    ...request,
    filters: {
      ...request.filters,
      selectedWorktree: normalizedWorktreePath,
    },
  };
}
