import { createBusNamespace } from '@makaio/core';
import { GitHookSchemas } from './schemas.js';

/**
 * Git-hook capability namespace for MakaioBus.
 *
 * Defines subjects used by the git hook extension to report native-hook
 * installation coverage to consumers such as GitWatcher.
 * @example
 * ```typescript
 * import { GitHookNamespace } from '@makaio/contracts';
 *
 * // Query coverage for a commit operation
 * const response = await bus.request(GitHookSubjects.coverage, {
 *   repoPath: '/path/to/repo',
 *   operation: 'commit',
 * });
 * ```
 */
export const GitHookNamespace = createBusNamespace('gitHook', GitHookSchemas);

/**
 * Type-safe subjects for git-hook capability operations.
 */
export const GitHookSubjects = GitHookNamespace.subjects;
