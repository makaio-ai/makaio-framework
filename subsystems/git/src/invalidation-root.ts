import { getRepoRoot } from './queries/index.js';

/**
 * Resolve repository root for cache invalidation.
 * @param repoPath - Repository path from request or event
 * @returns Repository root path if available, otherwise the provided path
 */
export async function resolveInvalidationRoot(repoPath: string): Promise<string> {
  const result = await getRepoRoot(repoPath);
  return result.root ?? repoPath;
}
