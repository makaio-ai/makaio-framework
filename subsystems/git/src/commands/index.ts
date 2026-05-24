/**
 * Git write command functions.
 *
 * Pure functions for git write operations using simple-git.
 * These are the counterpart to `queries/` for mutating operations.
 * @packageDocumentation
 */

// Types
export type {
  GitCommandResult,
  CommitResult,
  CommitOptions,
  MergeResult,
  MergeOptions,
  RebaseResult,
  RebaseOptions,
  StashResult,
  StashEntry,
  StashPushOptions,
  StashPopOptions,
  StashDropOptions,
  CreateBranchResult,
  DeleteBranchResult,
  CheckoutResult,
  CheckoutOptions,
  PushResult,
  PushOptions,
  PullResult,
  PullOptions,
  FetchResult,
  FetchOptions,
} from './types.js';

// Commit
export { commitChanges } from './commit.js';

// Branch
export { createBranch, deleteBranch, renameBranch } from './branch.js';

// Checkout
export { checkoutRef } from './checkout.js';

// Merge
export { mergeBranch, abortMerge } from './merge.js';

// Rebase
export { rebase } from './rebase.js';

// Stash
export { stashPush, stashPop, stashApply, stashList, stashDrop } from './stash.js';

// Remote operations
export { push, pull, fetch } from './remote-ops.js';

// Discard
export { discardChanges } from './discard.js';
