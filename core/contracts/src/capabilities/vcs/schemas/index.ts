import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { VCSCommitStatusSchema } from './statuses.js';
import { VCSReviewCommentSchema } from './review.js';

// Re-export all schema types
export { VCSRepositorySchema } from './repository.js';
export type { VCSRepository } from './repository.js';
export { VCSPullRequestDetailSchema, VCSPullRequestSchema, VCSReviewSchema } from './pr.js';
export type { VCSPullRequest, VCSPullRequestDetail, VCSReview } from './pr.js';
export { VCSCheckRunSchema } from './checks.js';
export type { VCSCheckRun } from './checks.js';
export { VCSCommitStatusSchema } from './statuses.js';
export type { VCSCommitStatus } from './statuses.js';
export { VCSReviewCommentSchema } from './review.js';
export type { VCSReviewComment } from './review.js';

/**
 * Shared head ref schema for PR schemas.
 */
const PRHeadRefSchema = z
  .object({
    ref: z.string(),
    sha: z.string(),
  })
  .nullish();

/**
 * Base PR summary schema shared between pr.list and pr.listForFile.
 */
const PRSummarySchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  author: z.string(),
  branch: z.string(),
  baseBranch: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
  head: PRHeadRefSchema,
});

/**
 * Extended PR summary with optional stats (for pr.list responses).
 */
const PRListItemSchema = PRSummarySchema.extend({
  additions: z.number().optional(),
  deletions: z.number().optional(),
  changedFiles: z.number().optional(),
  commentCount: z.number().optional(),
  reviewCount: z.number().optional(),
});

/**
 * VCS capability schemas for bus subjects.
 *
 * Defines the request/response shapes for all VCS operations
 * that can be invoked via the MakaioBus.
 */
export const VCSSchemas = {
  /**
   * Get repository information for a given path.
   *
   * Subject: `vcs.repository.get`
   * Type: Request (RPC)
   */
  'repository.get': {
    request: z.object({
      /** Local filesystem path to the repository */
      repoPath: z.string(),
    }),
    response: z.object({
      /** Repository metadata (null if not a VCS repo) */
      repository: z
        .object({
          provider: z.string(),
          owner: z.string(),
          repo: z.string(),
          url: z.string(),
          defaultBranch: z.string().optional(),
        })
        .nullable(),
    }),
  },

  /**
   * List pull requests for a repository branch.
   *
   * Subject: `vcs.pr.list`
   * Type: Request (RPC)
   */
  'pr.list': {
    request: z.object({
      /** Local filesystem path to the repository */
      repoPath: z.string(),
      /** Branch name to filter PRs (empty for all branches) */
      branch: z.string(),
    }),
    response: z.object({
      /** List of pull requests */
      pullRequests: z.array(PRListItemSchema),
    }),
  },

  /**
   * Get detailed information about a specific pull request.
   *
   * Subject: `vcs.pr.get`
   * Type: Request (RPC)
   */
  'pr.get': {
    request: z.object({
      /** Local filesystem path to the repository */
      repoPath: z.string(),
      /** Pull request number */
      prNumber: z.number(),
    }),
    response: z.object({
      /** Detailed pull request information (null if not found) */
      pullRequest: PRListItemSchema.extend({
        body: z.string().nullable(),
        reviews: z.array(
          z.object({
            id: z.number(),
            author: z.string(),
            state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'PENDING', 'DISMISSED']),
            body: z.string().nullable(),
            submittedAt: z.string().nullable(),
          }),
        ),
        labels: z.array(z.string()),
        assignees: z.array(z.string()),
        requestedReviewers: z.array(z.string()),
        mergeable: z.boolean().nullable(),
        mergeableState: z.string().optional(),
      }).nullable(),
    }),
  },

  /**
   * List PRs affecting a specific file.
   *
   * Subject: `vcs.pr.listForFile`
   * Type: Request (RPC)
   */
  'pr.listForFile': {
    request: z.object({
      /** Local filesystem path to the repository */
      repoPath: z.string(),
      /** Path to file relative to repo root */
      filePath: z.string(),
    }),
    response: z.object({
      /** List of PRs affecting this file */
      pullRequests: z.array(PRSummarySchema),
    }),
  },

  /**
   * Get CI/CD check runs for a commit.
   *
   * Subject: `vcs.checks.get`
   * Type: Request (RPC)
   */
  'checks.get': {
    request: z.object({
      /** Local filesystem path to the repository */
      repoPath: z.string(),
      /** Commit SHA to get checks for */
      commitSha: z.string(),
    }),
    response: z.object({
      /** List of check runs */
      checks: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          status: z.enum(['queued', 'in_progress', 'completed']),
          conclusion: z
            .enum(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required'])
            .nullable(),
          startedAt: z.string().nullable(),
          completedAt: z.string().nullable(),
          url: z.string(),
          workflowName: z.string().optional(),
          jobName: z.string().optional(),
        }),
      ),
    }),
  },

  /**
   * Get commit statuses for a commit (legacy status API).
   *
   * Subject: `vcs.statuses.get`
   * Type: Request (RPC)
   */
  'statuses.get': {
    request: z.object({
      /** Local filesystem path to the repository */
      repoPath: z.string(),
      /** Commit SHA to get statuses for */
      commitSha: z.string(),
    }),
    response: z.object({
      /** List of commit statuses */
      statuses: z.array(VCSCommitStatusSchema),
    }),
  },

  /**
   * Get review comments for a pull request.
   *
   * Subject: `vcs.comments.list`
   * Type: Request (RPC)
   */
  'comments.list': {
    request: z.object({
      /** Local filesystem path to the repository */
      repoPath: z.string(),
      /** Pull request number */
      prNumber: z.number(),
    }),
    response: z.object({
      /** List of review comments */
      comments: z.array(VCSReviewCommentSchema),
    }),
  },

  /**
   * Reply to an existing review comment.
   *
   * Subject: `vcs.comments.reply`
   * Type: Request (RPC)
   */
  'comments.reply': {
    request: z.object({
      /** Local filesystem path to the repository */
      repoPath: z.string(),
      /** Pull request number */
      prNumber: z.number(),
      /** Comment ID to reply to */
      commentId: z.number(),
      /** Reply body text */
      body: z.string(),
    }),
    response: z.object({
      /** Created reply comment */
      comment: VCSReviewCommentSchema,
    }),
  },

  /**
   * Post a new inline comment on a file:line.
   *
   * Subject: `vcs.comments.create`
   * Type: Request (RPC)
   */
  'comments.create': {
    request: z.object({
      /** Local filesystem path to the repository */
      repoPath: z.string(),
      /** Pull request number */
      prNumber: z.number(),
      /** File path relative to repo root */
      path: z.string(),
      /** Line number in the file */
      line: z.number(),
      /** Commit SHA this comment refers to */
      commitId: z.string(),
      /** Comment body text */
      body: z.string(),
      /** Side of diff (default: RIGHT) */
      side: z.enum(['LEFT', 'RIGHT']).optional(),
    }),
    response: z.object({
      /** Created comment */
      comment: VCSReviewCommentSchema,
    }),
  },

  /**
   * Resolve a review thread.
   *
   * Subject: `vcs.comments.resolveThread`
   * Type: Request (RPC)
   */
  'comments.resolveThread': {
    request: z.object({
      /** Local filesystem path to the repository */
      repoPath: z.string(),
      /** Pull request number */
      prNumber: z.number(),
      /** Thread ID (GraphQL node ID) */
      threadId: z.string(),
    }),
    response: z.object({
      /** Success indicator */
      success: z.boolean(),
    }),
  },

  /**
   * Get write capability level for current user.
   *
   * Subject: `vcs.capability.write`
   * Type: Request (RPC)
   */
  'capability.write': {
    request: z.object({
      /** Local filesystem path to the repository */
      repoPath: z.string(),
    }),
    response: z.object({
      /** Whether user can write (push permission) */
      canWrite: z.boolean(),
      /** Permission level */
      level: z.enum(['none', 'read', 'triage', 'write', 'maintain', 'admin']),
    }),
  },
} satisfies SchemaRecord;
