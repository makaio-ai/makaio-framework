import { z } from 'zod';

/**
 * Git operations that can be covered by native hook installation.
 */
export const GitHookCoveredOperationSchema = z.enum(['commit', 'checkout', 'merge', 'rebase']);
export type GitHookCoveredOperation = z.infer<typeof GitHookCoveredOperationSchema>;

/**
 * Rewritten commit pair reported by Git's `post-rewrite` hook.
 */
export const GitHookRewritePairSchema = z.object({
  /** Commit hash before the rewrite. */
  oldHash: z.string().min(1),
  /** Commit hash after the rewrite. */
  newHash: z.string().min(1),
});
export type GitHookRewritePair = z.infer<typeof GitHookRewritePairSchema>;

/**
 * Native `post-merge` hook event metadata.
 *
 * Git's post-merge hook does not expose the source branch, so this event keeps
 * hook-sourced data separate from the canonical `git.merge` event.
 */
export const GitHookNativeMergeEventSchema = z.object({
  /** Absolute repository root whose hook fired. */
  repoPath: z.string().min(1),
  /** Whether Git invoked the hook after a squash merge. */
  squash: z.boolean(),
  /** Current branch after the merge, when resolvable. */
  targetBranch: z.string().min(1).optional(),
  /** Current HEAD after the merge, when resolvable. */
  currentHead: z.string().min(1).optional(),
  /** Event timestamp (ISO 8601). */
  timestamp: z.string(),
});
export type GitHookNativeMergeEvent = z.infer<typeof GitHookNativeMergeEventSchema>;

/**
 * Native `post-rewrite` hook event metadata.
 */
export const GitHookRewriteEventSchema = z.object({
  /** Absolute repository root whose hook fired. */
  repoPath: z.string().min(1),
  /** Git rewrite command passed as argv[0], such as `rebase` or `amend`. */
  command: z.string().min(1),
  /** Rewritten commit pairs streamed by Git on hook stdin. */
  rewritten: z.array(GitHookRewritePairSchema),
  /** Current branch after the rewrite, when resolvable. */
  branch: z.string().min(1).optional(),
  /** Event timestamp (ISO 8601). */
  timestamp: z.string(),
});
export type GitHookRewriteEvent = z.infer<typeof GitHookRewriteEventSchema>;

/**
 * Machine-readable reason codes for hook coverage diagnostics.
 *
 * - `covered` – the hook is installed and verified for this operation.
 * - `not-installed` – the hook extension has not been installed into this repo at all.
 * - `hook-missing` – the hook file is absent from `.git/hooks/`.
 * - `hook-not-executable` – the hook file exists but lacks the executable bit.
 * - `state-missing` – the hook state file is absent, preventing verification.
 * - `state-mismatch` – the hook state file refers to a different installation.
 * - `unsupported-operation` – the operation is not tracked by the hook extension.
 * - `provider-unavailable` – no provider is registered to answer the query.
 */
export const GitHookCoverageReasonSchema = z.enum([
  'covered',
  'not-installed',
  'hook-missing',
  'hook-not-executable',
  'state-missing',
  'state-mismatch',
  'unsupported-operation',
  'provider-unavailable',
]);
export type GitHookCoverageReason = z.infer<typeof GitHookCoverageReasonSchema>;

/**
 * Request payload for a git hook coverage query.
 */
export const GitHookCoverageRequestSchema = z.object({
  /** Absolute repository root whose native hook coverage is being queried. */
  repoPath: z.string().min(1),
  /** Git operation GitWatcher is about to emit from filesystem inference. */
  operation: GitHookCoveredOperationSchema,
  /** Worktree name from GitWatcher when the filesystem event is worktree-scoped. */
  worktree: z.string().optional(),
});
export type GitHookCoverageRequest = z.infer<typeof GitHookCoverageRequestSchema>;

/**
 * Response payload for a git hook coverage query.
 */
export const GitHookCoverageResponseSchema = z.object({
  /** Whether the native hook install covers this repo and operation. */
  covered: z.boolean(),
  /** Machine-readable reason for diagnostics and tests. */
  reason: GitHookCoverageReasonSchema,
  /** All operations verified as covered for this repository. */
  coveredOperations: z.array(GitHookCoveredOperationSchema),
});
export type GitHookCoverageResponse = z.infer<typeof GitHookCoverageResponseSchema>;

/**
 * Aggregated schema map for the git-hook capability namespace.
 */
export const GitHookSchemas = {
  coverage: {
    request: GitHookCoverageRequestSchema,
    response: GitHookCoverageResponseSchema,
  },
  /** Native post-merge hook metadata. */
  merge: GitHookNativeMergeEventSchema,
  /** Native post-rewrite hook metadata. */
  rewrite: GitHookRewriteEventSchema,
};
