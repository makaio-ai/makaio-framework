/**
 * Shared types for git write command results.
 *
 * These are internal to the git-service command layer.
 * Bus contracts will wrap these when wiring handlers.
 * @packageDocumentation
 */

/**
 * Result of a git write operation.
 * All write commands return a discriminated success/error result
 * rather than throwing exceptions.
 */
export interface GitCommandResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message if the operation failed */
  error?: string;
}

/** Result of a commit operation. */
export interface CommitResult extends GitCommandResult {
  /** Commit hash (only present on success) */
  hash?: string;
  /** Commit message used */
  message?: string;
}

/** Options for commit operation. */
export interface CommitOptions {
  /** Amend the previous commit */
  amend?: boolean;
  /** Allow empty commit (no changes staged) */
  allowEmpty?: boolean;
  /** Author override in "Name <email>" format */
  author?: string;
}

/** Result of a merge operation. */
export interface MergeResult extends GitCommandResult {
  /** Merge commit hash (only present for non-fast-forward merges) */
  mergeCommit?: string;
  /** Whether the merge was fast-forward */
  fastForward?: boolean;
  /** List of conflicted file paths (present when merge has conflicts) */
  conflicts?: string[];
}

/** Options for merge operation. */
export interface MergeOptions {
  /** Merge strategy (e.g., 'ort', 'recursive', 'ours') */
  strategy?: string;
  /** Force no-fast-forward merge */
  noFf?: boolean;
  /** Only allow fast-forward merge */
  ffOnly?: boolean;
  /** Squash commits into working tree without creating a merge commit */
  squash?: boolean;
  /** Custom commit message for merge */
  message?: string;
}

/** Result of a rebase operation. */
export interface RebaseResult extends GitCommandResult {
  /** Whether auto-stash was used */
  autoStashed?: boolean;
  /** Whether stash was successfully popped after rebase */
  stashPopped?: boolean;
  /** List of conflicted file paths (present when rebase has conflicts) */
  conflicts?: string[];
}

/** Options for rebase operation. */
export interface RebaseOptions {
  /** Automatically stash/pop dirty working tree */
  autoStash?: boolean;
  /** Interactive rebase (abort/continue/skip) */
  action?: 'continue' | 'abort' | 'skip';
}

/** Stash entry returned from stash list. */
export interface StashEntry {
  /** Stash index (0 = most recent) */
  index: number;
  /** Stash reference (e.g., 'stash\@\{0\}') */
  ref: string;
  /** Stash message */
  message: string;
  /** Branch the stash was created on */
  branch: string;
  /** Author date (ISO 8601) */
  date: string;
}

/** Result of a stash operation. */
export interface StashResult extends GitCommandResult {
  /** Stash entries (only for 'list' action) */
  entries?: StashEntry[];
  /** Stash reference (only for 'push' action) */
  ref?: string;
}

/** Options for stash push. */
export interface StashPushOptions {
  /** Stash message */
  message?: string;
  /** Include untracked files */
  includeUntracked?: boolean;
}

/** Options for stash pop/apply. */
export interface StashPopOptions {
  /** Stash index to pop (default: 0) */
  index?: number;
}

/** Options for stash drop. */
export interface StashDropOptions {
  /** Stash index to drop (default: 0) */
  index?: number;
}

/** Result of a branch creation. */
export interface CreateBranchResult extends GitCommandResult {
  /** Name of the created branch */
  branch?: string;
}

/** Result of a branch deletion. */
export interface DeleteBranchResult extends GitCommandResult {
  /** Name of the deleted branch */
  branch?: string;
}

/** Result of a checkout operation. */
export interface CheckoutResult extends GitCommandResult {
  /** Branch or ref checked out */
  target?: string;
  /** Whether a new branch was created */
  created?: boolean;
}

/** Options for checkout operation. */
export interface CheckoutOptions {
  /** Create a new branch at the target */
  createBranch?: boolean;
  /** Start point for the new branch (defaults to HEAD) */
  startPoint?: string;
}

/** Result of a push operation. */
export interface PushResult extends GitCommandResult {
  /** Remote name that was pushed to */
  remote?: string;
  /** Branch that was pushed */
  branch?: string;
}

/** Options for push operation. */
export interface PushOptions {
  /** Set upstream tracking */
  setUpstream?: boolean;
  /** Push tags */
  tags?: boolean;
}

/** Result of a pull operation. */
export interface PullResult extends GitCommandResult {
  /** Whether the pull resulted in new changes */
  updated?: boolean;
  /** List of conflicted file paths */
  conflicts?: string[];
}

/** Options for pull operation. */
export interface PullOptions {
  /** Rebase instead of merge */
  rebase?: boolean;
}

/** Result of a fetch operation. */
export interface FetchResult extends GitCommandResult {
  /** Remote that was fetched from */
  remote?: string;
}

/** Options for fetch operation. */
export interface FetchOptions {
  /** Prune remote-tracking refs that no longer exist */
  prune?: boolean;
  /** Fetch all remotes */
  all?: boolean;
  /** Fetch tags */
  tags?: boolean;
}
