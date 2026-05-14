import { createBusNamespace } from '@makaio/core';
import { VCSSchemas } from './schemas/index.js';

/**
 * VCS namespace for MakaioBus.
 *
 * Defines VCS capability subjects for explicit registration by composition
 * roots.
 * @example
 * ```typescript
 * import { VCSNamespace } from '@makaio/contracts';
 *
 * // Request repository info
 * const { repository } = await VCSNamespace.subjects['repository.get']({
 *   repoPath: '/path/to/repo'
 * });
 *
 * // List pull requests
 * const { pullRequests } = await VCSNamespace.subjects['pr.list']({
 *   repoPath: '/path/to/repo',
 *   branch: 'main'
 * });
 * ```
 */
export const VCSNamespace = createBusNamespace('vcs', VCSSchemas);

/**
 * Type-safe subjects for VCS operations.
 *
 * Provides strongly-typed request/response handlers for each VCS subject.
 */
export const VCSSubjects = VCSNamespace.subjects;
