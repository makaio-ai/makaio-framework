import type { SchemaRecord } from '@makaio/core';
import { createBusNamespace } from '@makaio/core';
import {
  GitRepoRootRequestSchema,
  GitRepoRootResponseSchema,
  GitBranchRequestSchema,
  GitBranchResponseSchema,
  GitCommitRequestSchema,
  GitCommitResponseSchema,
  GitCommitDetailsRequestSchema,
  GitCommitDetailsResponseSchema,
  GitWorkingTreeDetailsRequestSchema,
  GitWorkingTreeDetailsResponseSchema,
  GitStatusRequestSchema,
  GitStatusResponseSchema,
  GitWorktreesRequestSchema,
  GitWorktreesResponseSchema,
  GitRemotesRequestSchema,
  GitRemotesResponseSchema,
  GitDefaultBranchRequestSchema,
  GitDefaultBranchResponseSchema,
  GitLogRequestSchema,
  GitLogResponseSchema,
  GitLocalBranchExistsRequestSchema,
  GitLocalBranchExistsResponseSchema,
  GitFileAtRevisionRequestSchema,
  GitFileAtRevisionResponseSchema,
  GitDiffRequestSchema,
  GitDiffResponseSchema,
  GetBranchCommitsRequestSchema,
  GetBranchCommitsResponseSchema,
  GitSwitchWorktreeRequestSchema,
  GitSwitchWorktreeResponseSchema,
  GitBlameRequestSchema,
  GitBlameResponseSchema,
  GitFingerprintRequestSchema,
  GitFingerprintResponseSchema,
  GitFileAtCommitRequestSchema,
  GitFileAtCommitResponseSchema,
  GitBlobHashAtCommitRequestSchema,
  GitBlobHashAtCommitResponseSchema,
} from './schemas/query.js';
import {
  GitCreateCommitRequestSchema,
  GitCreateCommitResponseSchema,
  GitMergeRequestSchema,
  GitMergeResponseSchema,
  GitAbortMergeRequestSchema,
  GitAbortMergeResponseSchema,
  GitRebaseOntoRequestSchema,
  GitRebaseOntoResponseSchema,
  GitStashRequestSchema,
  GitStashResponseSchema,
  GitCreateBranchRequestSchema,
  GitCreateBranchResponseSchema,
  GitDeleteBranchRequestSchema,
  GitDeleteBranchResponseSchema,
  GitRenameBranchRequestSchema,
  GitRenameBranchResponseSchema,
  GitCheckoutRequestSchema,
  GitCheckoutResponseSchema,
  GitPushRequestSchema,
  GitPushResponseSchema,
  GitPullRequestSchema,
  GitPullResponseSchema,
  GitFetchRequestSchema,
  GitFetchResponseSchema,
  GitDiscardChangesRequestSchema,
  GitDiscardChangesResponseSchema,
} from './schemas/write.js';
import {
  GitCommitEventSchema,
  GitCheckoutEventSchema,
  GitStagingEventSchema,
  GitMergeEventSchema,
  GitRebaseEventSchema,
  GitWorktreeEventSchema,
  GitAddRepoRequestSchema,
  GitAddRepoResponseSchema,
  GitRemoveRepoRequestSchema,
  GitRemoveRepoResponseSchema,
  GitInitRepoRequestSchema,
  GitInitRepoResponseSchema,
  GitCreateWorktreeRequestSchema,
  GitCreateWorktreeResponseSchema,
  GitRemoveWorktreeRequestSchema,
  GitRemoveWorktreeResponseSchema,
  GitStageRequestSchema,
  GitStageResponseSchema,
  GitUnstageRequestSchema,
  GitUnstageResponseSchema,
} from './schemas/event.js';

/**
 * Unified Git namespace schemas.
 *
 * This namespace contains:
 * - Query subjects: getRepoRoot, getBranch, getCommit, getCommitDetails, getWorkingTreeDetails,
 *   getStatus, getWorktrees, getRemotes, getDefaultBranch, getLog, localBranchExists, getFileAtRevision, getDiff,
 *   getBranchCommits, switchWorktree, getBlame, fingerprint, getFileAtCommit, getBlobHashAtCommit
 * - Event subjects (fire-and-forget): commit, checkout, staging, merge, rebase, worktree
 * - Control subjects: addRepo, removeRepo, initRepo, createWorktree, removeWorktree, stage, unstage
 * - Write subjects: createCommit, mergeBranch, mergeAbort, rebaseOnto, stash, createBranch, deleteBranch,
 *   renameBranch, checkoutRef, push, pull, fetch, discardChanges
 *
 * All git-related subjects are registered here. GitService handles implementation.
 */
const GitSchemas = {
  // ==========================================================================
  // Query subjects (request/response)
  // ==========================================================================
  /** Get repository root directory from any path within the repo */
  getRepoRoot: {
    request: GitRepoRootRequestSchema,
    response: GitRepoRootResponseSchema,
  },
  /** Get current branch info */
  getBranch: {
    request: GitBranchRequestSchema,
    response: GitBranchResponseSchema,
  },
  /** Check whether a local branch ref exists (host-owned only) */
  localBranchExists: {
    request: GitLocalBranchExistsRequestSchema,
    response: GitLocalBranchExistsResponseSchema,
  },
  /** Get commit info for a ref */
  getCommit: {
    request: GitCommitRequestSchema,
    response: GitCommitResponseSchema,
  },
  /** Get commit changes (files and stats) */
  getCommitDetails: {
    request: GitCommitDetailsRequestSchema,
    response: GitCommitDetailsResponseSchema,
  },
  /** Get working tree changes (files and stats) */
  getWorkingTreeDetails: {
    request: GitWorkingTreeDetailsRequestSchema,
    response: GitWorkingTreeDetailsResponseSchema,
  },
  /** Get working directory status */
  getStatus: {
    request: GitStatusRequestSchema,
    response: GitStatusResponseSchema,
  },
  /** List git worktrees */
  getWorktrees: {
    request: GitWorktreesRequestSchema,
    response: GitWorktreesResponseSchema,
  },
  /** List configured remotes */
  getRemotes: {
    request: GitRemotesRequestSchema,
    response: GitRemotesResponseSchema,
  },
  /** Get repository default branch */
  getDefaultBranch: {
    request: GitDefaultBranchRequestSchema,
    response: GitDefaultBranchResponseSchema,
  },
  /** Get commit history with optional filters */
  getLog: {
    request: GitLogRequestSchema,
    response: GitLogResponseSchema,
  },
  /** Get file content at a specific revision */
  getFileAtRevision: {
    request: GitFileAtRevisionRequestSchema,
    response: GitFileAtRevisionResponseSchema,
  },
  /** Get file content at a specific commit (returns null content if file not present at commit) */
  getFileAtCommit: {
    request: GitFileAtCommitRequestSchema,
    response: GitFileAtCommitResponseSchema,
  },
  /** Get the git blob hash for a file at a specific commit (null if not present) */
  getBlobHashAtCommit: {
    request: GitBlobHashAtCommitRequestSchema,
    response: GitBlobHashAtCommitResponseSchema,
  },
  /** Get unified diff for the working tree */
  getDiff: {
    request: GitDiffRequestSchema,
    response: GitDiffResponseSchema,
  },
  /** Get all commit hashes reachable from a branch */
  getBranchCommits: {
    request: GetBranchCommitsRequestSchema,
    response: GetBranchCommitsResponseSchema,
  },
  /** Switch to a different worktree */
  switchWorktree: {
    request: GitSwitchWorktreeRequestSchema,
    response: GitSwitchWorktreeResponseSchema,
  },
  /** Get blame annotations for a file */
  getBlame: {
    request: GitBlameRequestSchema,
    response: GitBlameResponseSchema,
  },
  /** Compute content-aware fingerprint of repository state */
  fingerprint: {
    request: GitFingerprintRequestSchema,
    response: GitFingerprintResponseSchema,
  },

  // ==========================================================================
  // Event subjects (fire-and-forget)
  // ==========================================================================
  /** Commit event - new commit detected */
  commit: GitCommitEventSchema,
  /** Checkout event - branch switch detected */
  checkout: GitCheckoutEventSchema,
  /** Staging event - files staged for commit */
  staging: GitStagingEventSchema,
  /** Merge event - merge operation detected */
  merge: GitMergeEventSchema,
  /** Rebase event - rebase operation detected */
  rebase: GitRebaseEventSchema,
  /** Worktree event - worktree added or removed */
  worktree: GitWorktreeEventSchema,

  // ==========================================================================
  // Control subjects (request/response)
  // ==========================================================================
  /** Add a repo to watch */
  addRepo: {
    request: GitAddRepoRequestSchema,
    response: GitAddRepoResponseSchema,
  },
  /** Remove a repo from watching */
  removeRepo: {
    request: GitRemoveRepoRequestSchema,
    response: GitRemoveRepoResponseSchema,
  },
  /** Initialize a new git repository */
  initRepo: {
    request: GitInitRepoRequestSchema,
    response: GitInitRepoResponseSchema,
  },
  /** Create a new worktree */
  createWorktree: {
    request: GitCreateWorktreeRequestSchema,
    response: GitCreateWorktreeResponseSchema,
  },
  /** Remove a worktree */
  removeWorktree: {
    request: GitRemoveWorktreeRequestSchema,
    response: GitRemoveWorktreeResponseSchema,
  },
  /** Stage files for commit */
  stage: {
    request: GitStageRequestSchema,
    response: GitStageResponseSchema,
  },
  /** Unstage files (remove from staging area) */
  unstage: {
    request: GitUnstageRequestSchema,
    response: GitUnstageResponseSchema,
  },

  // ==========================================================================
  // Write subjects (request/response, mutate repository state)
  // ==========================================================================
  /** Create a commit from currently staged changes */
  createCommit: {
    request: GitCreateCommitRequestSchema,
    response: GitCreateCommitResponseSchema,
  },
  /** Merge a branch into the current branch */
  mergeBranch: {
    request: GitMergeRequestSchema,
    response: GitMergeResponseSchema,
  },
  /** Abort an in-progress merge */
  mergeAbort: {
    request: GitAbortMergeRequestSchema,
    response: GitAbortMergeResponseSchema,
  },
  /** Rebase current branch onto a target */
  rebaseOnto: {
    request: GitRebaseOntoRequestSchema,
    response: GitRebaseOntoResponseSchema,
  },
  /** Stash operations (push, pop, apply, drop, list) */
  stash: {
    request: GitStashRequestSchema,
    response: GitStashResponseSchema,
  },
  /** Create a new branch */
  createBranch: {
    request: GitCreateBranchRequestSchema,
    response: GitCreateBranchResponseSchema,
  },
  /** Delete a branch */
  deleteBranch: {
    request: GitDeleteBranchRequestSchema,
    response: GitDeleteBranchResponseSchema,
  },
  /** Rename a branch */
  renameBranch: {
    request: GitRenameBranchRequestSchema,
    response: GitRenameBranchResponseSchema,
  },
  /** Checkout a branch, tag, or commit */
  checkoutRef: {
    request: GitCheckoutRequestSchema,
    response: GitCheckoutResponseSchema,
  },
  /** Push commits to a remote */
  push: {
    request: GitPushRequestSchema,
    response: GitPushResponseSchema,
  },
  /** Pull changes from a remote */
  pull: {
    request: GitPullRequestSchema,
    response: GitPullResponseSchema,
  },
  /** Fetch refs from a remote */
  fetch: {
    request: GitFetchRequestSchema,
    response: GitFetchResponseSchema,
  },
  /** Discard working tree changes for specific files */
  discardChanges: {
    request: GitDiscardChangesRequestSchema,
    response: GitDiscardChangesResponseSchema,
  },
} satisfies SchemaRecord;

/**
 * Unified Git namespace registration.
 */
export const GitNamespace = createBusNamespace('git', GitSchemas);

/**
 * Typed subjects for all git operations.
 */
export const GitSubjects = GitNamespace.subjects;
