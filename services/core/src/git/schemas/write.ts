import { z } from 'zod';

/**
 * Git write operation schemas.
 * Request/response schemas for git operations that mutate repository state:
 * commit, merge, rebase, stash, branch CRUD, checkout, push, pull, fetch, discard.
 */

/** Request to create a commit from currently staged changes. */
export const GitCreateCommitRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** Commit message */
  message: z.string().min(1),
  /** Allow creating an empty commit (no staged changes) */
  allowEmpty: z.boolean().optional(),
  /** Amend the previous commit instead of creating a new one */
  amend: z.boolean().optional(),
});
export type GitCreateCommitRequest = z.infer<typeof GitCreateCommitRequestSchema>;

/** Response from commit creation. */
export const GitCreateCommitResponseSchema = z.object({
  /** Whether the commit was created successfully */
  success: z.boolean(),
  /** Commit hash of the new commit */
  hash: z.string().optional(),
  /** Branch the commit was made on */
  branch: z.string().optional(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitCreateCommitResponse = z.infer<typeof GitCreateCommitResponseSchema>;

/**
 * Merge approach determines how the merge is performed.
 * - 'merge': Standard merge commit (default)
 * - 'squash': Squash all commits into a single commit
 * - 'fast-forward-only': Only allow fast-forward merges
 */
export const GitMergeApproachSchema = z.enum(['merge', 'squash', 'fast-forward-only']);
export type GitMergeApproach = z.infer<typeof GitMergeApproachSchema>;

/** Request to merge a branch into the current branch. */
export const GitMergeRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** Branch or ref to merge from */
  source: z.string(),
  /** Merge approach */
  approach: GitMergeApproachSchema.optional(),
  /** Custom commit message for the merge commit */
  message: z.string().optional(),
  /** Abort if there are conflicts instead of leaving conflict markers */
  abortOnConflict: z.boolean().optional(),
});
export type GitMergeRequest = z.infer<typeof GitMergeRequestSchema>;

/** Response from merge operation. */
export const GitMergeResponseSchema = z.object({
  /** Whether the merge completed successfully */
  success: z.boolean(),
  /** Resulting merge commit hash (absent for fast-forward or squash) */
  hash: z.string().optional(),
  /** Whether fast-forward was used */
  fastForward: z.boolean().optional(),
  /** List of conflicted files, if any */
  conflicts: z.array(z.string()).optional(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitMergeResponse = z.infer<typeof GitMergeResponseSchema>;

/** Request to abort an in-progress merge. */
export const GitAbortMergeRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
});
export type GitAbortMergeRequest = z.infer<typeof GitAbortMergeRequestSchema>;

/** Response from abort-merge operation. */
export const GitAbortMergeResponseSchema = z.object({
  /** Whether merge abort completed successfully */
  success: z.boolean(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitAbortMergeResponse = z.infer<typeof GitAbortMergeResponseSchema>;

/** Request to rebase the current branch onto a target ref. */
export const GitRebaseOntoRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** Target branch or ref to rebase onto */
  onto: z.string(),
  /** Abort an in-progress rebase instead of starting a new one */
  abort: z.boolean().optional(),
  /** Continue an in-progress rebase after resolving conflicts */
  continueRebase: z.boolean().optional(),
});
export type GitRebaseOntoRequest = z.infer<typeof GitRebaseOntoRequestSchema>;

/** Response from rebase operation. */
export const GitRebaseOntoResponseSchema = z.object({
  /** Whether the rebase completed successfully */
  success: z.boolean(),
  /** New HEAD commit hash after rebase */
  hash: z.string().optional(),
  /** List of conflicted files if rebase paused for conflict resolution */
  conflicts: z.array(z.string()).optional(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitRebaseOntoResponse = z.infer<typeof GitRebaseOntoResponseSchema>;

/**
 * Stash operation type.
 * - 'push': Stash current changes (default)
 * - 'pop': Apply and remove the top stash entry
 * - 'apply': Apply but keep the stash entry
 * - 'drop': Remove a stash entry without applying
 * - 'list': List all stash entries
 */
export const GitStashOperationSchema = z.enum(['push', 'pop', 'apply', 'drop', 'list']);
export type GitStashOperation = z.infer<typeof GitStashOperationSchema>;

/** Request to perform a stash operation. */
export const GitStashRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** Stash operation to perform */
  operation: GitStashOperationSchema,
  /** Optional message for push operation */
  message: z.string().optional(),
  /** Include untracked files in push operation */
  includeUntracked: z.boolean().optional(),
  /** Stash index for pop, apply, and drop operations (defaults to 0) */
  index: z.number().int().min(0).optional(),
});
export type GitStashRequest = z.infer<typeof GitStashRequestSchema>;

/** A single entry in the stash list. */
export const GitStashEntrySchema = z.object({
  /** Stash index (0 = most recent) */
  index: z.number(),
  /** Stash message */
  message: z.string(),
  /** Branch the stash was created on */
  branch: z.string(),
  /** Timestamp (ISO 8601) */
  date: z.string(),
});
export type GitStashEntry = z.infer<typeof GitStashEntrySchema>;

/** Response from stash operation. */
export const GitStashResponseSchema = z.object({
  /** Whether the operation succeeded */
  success: z.boolean(),
  /** Stash entries (populated for 'list' operation) */
  entries: z.array(GitStashEntrySchema).optional(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitStashResponse = z.infer<typeof GitStashResponseSchema>;

/** Request to create a new branch. */
export const GitCreateBranchRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** Name for the new branch */
  name: z.string(),
  /** Starting point (commit hash, branch, or tag). Defaults to HEAD. */
  startPoint: z.string().optional(),
  /** Switch to the new branch after creation */
  checkout: z.boolean().optional(),
});
export type GitCreateBranchRequest = z.infer<typeof GitCreateBranchRequestSchema>;

/** Response from branch creation. */
export const GitCreateBranchResponseSchema = z.object({
  /** Whether the branch was created successfully */
  success: z.boolean(),
  /** Name of the created branch */
  name: z.string().optional(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitCreateBranchResponse = z.infer<typeof GitCreateBranchResponseSchema>;

/** Request to delete a branch. */
export const GitDeleteBranchRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** Branch name to delete */
  name: z.string(),
  /** Force deletion even if branch has unmerged changes */
  force: z.boolean().optional(),
});
export type GitDeleteBranchRequest = z.infer<typeof GitDeleteBranchRequestSchema>;

/** Response from branch deletion. */
export const GitDeleteBranchResponseSchema = z.object({
  /** Whether the branch was deleted successfully */
  success: z.boolean(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitDeleteBranchResponse = z.infer<typeof GitDeleteBranchResponseSchema>;

/** Request to rename a branch. */
export const GitRenameBranchRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** Current branch name */
  oldName: z.string(),
  /** New branch name */
  newName: z.string(),
});
export type GitRenameBranchRequest = z.infer<typeof GitRenameBranchRequestSchema>;

/** Response from branch rename. */
export const GitRenameBranchResponseSchema = z.object({
  /** Whether the rename was successful */
  success: z.boolean(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitRenameBranchResponse = z.infer<typeof GitRenameBranchResponseSchema>;

/** Request to checkout a branch, tag, or commit. */
export const GitCheckoutRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** Branch, tag, or commit to checkout */
  ref: z.string(),
  /** Create a new branch with this name and check it out */
  createBranch: z.boolean().optional(),
  /** Start point used when createBranch is true (commit hash, branch, or tag) */
  startPoint: z.string().optional(),
});
export type GitCheckoutRequest = z.infer<typeof GitCheckoutRequestSchema>;

/** Response from checkout operation. */
export const GitCheckoutResponseSchema = z.object({
  /** Whether the checkout succeeded */
  success: z.boolean(),
  /** Branch or ref now checked out */
  ref: z.string().optional(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitCheckoutResponse = z.infer<typeof GitCheckoutResponseSchema>;

/** Request to push commits to a remote. */
export const GitPushRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** Remote name (defaults to 'origin') */
  remote: z.string().optional(),
  /** Branch to push (defaults to current branch) */
  branch: z.string().optional(),
  /** Set upstream tracking reference */
  setUpstream: z.boolean().optional(),
  /** Force push (use with caution) */
  force: z.boolean().optional(),
});
export type GitPushRequest = z.infer<typeof GitPushRequestSchema>;

/** Response from push operation. */
export const GitPushResponseSchema = z.object({
  /** Whether the push succeeded */
  success: z.boolean(),
  /** Remote that was pushed to */
  remote: z.string().optional(),
  /** Branch that was pushed */
  branch: z.string().optional(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitPushResponse = z.infer<typeof GitPushResponseSchema>;

/** Request to pull changes from a remote. */
export const GitPullRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** Remote name (defaults to 'origin') */
  remote: z.string().optional(),
  /** Branch to pull (defaults to current tracking branch) */
  branch: z.string().optional(),
  /** Rebase instead of merge when pulling */
  rebase: z.boolean().optional(),
});
export type GitPullRequest = z.infer<typeof GitPullRequestSchema>;

/** Response from pull operation. */
export const GitPullResponseSchema = z.object({
  /** Whether the pull succeeded */
  success: z.boolean(),
  /** List of conflicted files, if any */
  conflicts: z.array(z.string()).optional(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitPullResponse = z.infer<typeof GitPullResponseSchema>;

/** Request to fetch from a remote. */
export const GitFetchRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** Remote name (defaults to 'origin'). Use '--all' to fetch all remotes. */
  remote: z.string().optional(),
  /** Prune remote-tracking refs that no longer exist on the remote */
  prune: z.boolean().optional(),
});
export type GitFetchRequest = z.infer<typeof GitFetchRequestSchema>;

/** Response from fetch operation. */
export const GitFetchResponseSchema = z.object({
  /** Whether the fetch succeeded */
  success: z.boolean(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitFetchResponse = z.infer<typeof GitFetchResponseSchema>;

/** Request to discard working tree changes. */
export const GitDiscardChangesRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** File paths to discard changes for (relative to repo root) */
  paths: z.array(z.string()).min(1),
});
export type GitDiscardChangesRequest = z.infer<typeof GitDiscardChangesRequestSchema>;

/** Response from discard operation. */
export const GitDiscardChangesResponseSchema = z.object({
  /** Whether the discard succeeded */
  success: z.boolean(),
  /** Error message if failed */
  error: z.string().optional(),
});
export type GitDiscardChangesResponse = z.infer<typeof GitDiscardChangesResponseSchema>;
