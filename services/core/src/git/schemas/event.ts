import { z } from 'zod';

/**
 * Git event schemas.
 * Emitted by GitService when git operations are detected via file watching.
 */

// =============================================================================
// commit - New commit detected
// =============================================================================

export const GitCommitEventSchema = z.object({
  /** Absolute path to the repository root */
  repoPath: z.string(),
  /** Commit hash (SHA) */
  hash: z.string(),
  /** Commit message */
  message: z.string(),
  /** Author name */
  author: z.string(),
  /** Author email */
  email: z.string(),
  /** Branch the commit was made on */
  branch: z.string(),
  /** Commit timestamp (ISO 8601) */
  timestamp: z.string(),
  /** Worktree name (undefined = main repo) */
  worktree: z.string().optional(),
});
export type GitCommitEvent = z.infer<typeof GitCommitEventSchema>;

// =============================================================================
// checkout - Branch switch detected
// =============================================================================

export const GitCheckoutEventSchema = z.object({
  /** Absolute path to the repository root */
  repoPath: z.string(),
  /** Previous branch (optional - may be undefined for initial checkout) */
  previousBranch: z.string().optional(),
  /** Current branch after checkout */
  currentBranch: z.string(),
  /** Checkout timestamp (ISO 8601) */
  timestamp: z.string(),
  /** Worktree name (undefined = main repo) */
  worktree: z.string().optional(),
});
export type GitCheckoutEvent = z.infer<typeof GitCheckoutEventSchema>;

// =============================================================================
// staging - Files staged for commit
// =============================================================================

export const GitStagingEventSchema = z.object({
  /** Absolute path to the repository root */
  repoPath: z.string(),
  /** List of staged file paths */
  staged: z.array(z.string()),
  /** Staging timestamp (ISO 8601) */
  timestamp: z.string(),
  /** Worktree name (undefined = main repo) */
  worktree: z.string().optional(),
});
export type GitStagingEvent = z.infer<typeof GitStagingEventSchema>;

// =============================================================================
// merge - Merge operation detected
// =============================================================================

export const GitMergeEventSchema = z.object({
  /** Absolute path to the repository root */
  repoPath: z.string(),
  /** Source branch being merged from */
  sourceBranch: z.string(),
  /** Target branch being merged into */
  targetBranch: z.string(),
  /** Resulting merge commit hash */
  mergeCommit: z.string(),
  /** Merge timestamp (ISO 8601) */
  timestamp: z.string(),
  /** Worktree name (undefined = main repo) */
  worktree: z.string().optional(),
});
export type GitMergeEvent = z.infer<typeof GitMergeEventSchema>;

// =============================================================================
// rebase - Rebase operation detected
// =============================================================================

export const GitRebaseStatusSchema = z.enum(['started', 'completed', 'aborted']);
export type GitRebaseStatus = z.infer<typeof GitRebaseStatusSchema>;

export const GitRebaseEventSchema = z.object({
  /** Absolute path to the repository root */
  repoPath: z.string(),
  /** Branch being rebased */
  branch: z.string(),
  /** Target branch or commit to rebase onto */
  onto: z.string(),
  /** Rebase operation status */
  status: GitRebaseStatusSchema,
  /** Rebase timestamp (ISO 8601) */
  timestamp: z.string(),
  /** Worktree name (undefined = main repo) */
  worktree: z.string().optional(),
});
export type GitRebaseEvent = z.infer<typeof GitRebaseEventSchema>;

// =============================================================================
// worktree - Worktree added or removed
// =============================================================================

export const GitWorktreeEventSchema = z.object({
  /** Absolute path to the repository root */
  repoPath: z.string(),
  /** Worktree name */
  name: z.string(),
  /** Worktree path on disk */
  path: z.string(),
  /** Branch checked out in worktree */
  branch: z.string(),
  /** Event type */
  event: z.enum(['added', 'removed']),
  /** Timestamp (ISO 8601) */
  timestamp: z.string(),
});
export type GitWorktreeEvent = z.infer<typeof GitWorktreeEventSchema>;

// =============================================================================
// addRepo / removeRepo - Control subjects for multi-repo watching
// =============================================================================

export const GitAddRepoRequestSchema = z.object({
  /** Absolute path to repo root */
  repoPath: z.string(),
});
export type GitAddRepoRequest = z.infer<typeof GitAddRepoRequestSchema>;

export const GitAddRepoResponseSchema = z.object({
  /** Whether the repo was added successfully */
  success: z.boolean(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitAddRepoResponse = z.infer<typeof GitAddRepoResponseSchema>;

export const GitRemoveRepoRequestSchema = z.object({
  /** Absolute path to repo root */
  repoPath: z.string(),
});
export type GitRemoveRepoRequest = z.infer<typeof GitRemoveRepoRequestSchema>;

export const GitRemoveRepoResponseSchema = z.object({
  /** Whether the repo was removed successfully */
  success: z.boolean(),
});
export type GitRemoveRepoResponse = z.infer<typeof GitRemoveRepoResponseSchema>;

// =============================================================================
// initRepo - Initialize git repository
// =============================================================================

export const GitInitRepoRequestSchema = z.object({
  /** Directory path to initialize as git repo */
  path: z.string(),
  /** Default branch name (defaults to 'main') */
  defaultBranch: z.string().optional(),
});
export type GitInitRepoRequest = z.infer<typeof GitInitRepoRequestSchema>;

export const GitInitRepoResponseSchema = z.object({
  /** Whether initialization succeeded */
  success: z.boolean(),
  /** Initialized repository path */
  path: z.string(),
  /** Branch name that was created */
  defaultBranch: z.string(),
});
export type GitInitRepoResponse = z.infer<typeof GitInitRepoResponseSchema>;

// =============================================================================
// createWorktree - Create a new git worktree
// =============================================================================

export const GitCreateWorktreeRequestSchema = z.object({
  /** Repository path containing the main worktree */
  repoPath: z.string(),
  /** Path where the new worktree will be created */
  path: z.string(),
  /** Branch name to create/checkout in the worktree */
  branch: z.string(),
  /** Base ref to create branch from (defaults to HEAD) */
  baseBranch: z.string().optional(),
  /** Create a new branch (true) or checkout existing (false, default) */
  createBranch: z.boolean().optional(),
});
export type GitCreateWorktreeRequest = z.infer<typeof GitCreateWorktreeRequestSchema>;

export const GitCreateWorktreeResponseSchema = z.object({
  /** Whether creation succeeded */
  success: z.boolean(),
  /** Path to created worktree */
  path: z.string(),
  /** Branch checked out in worktree */
  branch: z.string(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitCreateWorktreeResponse = z.infer<typeof GitCreateWorktreeResponseSchema>;

// =============================================================================
// removeWorktree - Remove a git worktree
// =============================================================================

export const GitRemoveWorktreeRequestSchema = z.object({
  /** Repository path containing the main worktree */
  repoPath: z.string(),
  /** Path to the worktree to remove */
  path: z.string(),
  /** Force removal even if worktree has uncommitted changes */
  force: z.boolean().optional(),
  /** Also delete the branch after removing worktree */
  deleteBranch: z.boolean().optional(),
});
export type GitRemoveWorktreeRequest = z.infer<typeof GitRemoveWorktreeRequestSchema>;

export const GitRemoveWorktreeResponseSchema = z.object({
  /** Whether removal succeeded */
  success: z.boolean(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitRemoveWorktreeResponse = z.infer<typeof GitRemoveWorktreeResponseSchema>;

// =============================================================================
// stage / unstage - Stage/unstage files for commit
// =============================================================================

/**
 * Request to stage files for commit
 */
export const GitStageRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** File paths to stage (relative to repo root) */
  paths: z.array(z.string()).min(1),
});
export type GitStageRequest = z.infer<typeof GitStageRequestSchema>;

/**
 * Response from stage operation
 */
export const GitStageResponseSchema = z.object({
  /** Whether the operation succeeded */
  success: z.boolean(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitStageResponse = z.infer<typeof GitStageResponseSchema>;

/**
 * Request to unstage files (remove from staging area)
 */
export const GitUnstageRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** File paths to unstage (relative to repo root) */
  paths: z.array(z.string()).min(1),
});
export type GitUnstageRequest = z.infer<typeof GitUnstageRequestSchema>;

/**
 * Response from unstage operation
 */
export const GitUnstageResponseSchema = z.object({
  /** Whether the operation succeeded */
  success: z.boolean(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitUnstageResponse = z.infer<typeof GitUnstageResponseSchema>;
