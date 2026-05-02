import { z } from 'zod';

/**
 * Zod schema for a pull request summary.
 *
 * Contains essential information about a PR for list views.
 */
export const VCSPullRequestSchema = z.object({
  /** Unique provider identifier for the PR (e.g., "owner/repo#123") */
  id: z.string(),
  /** Pull request number */
  number: z.number(),
  /** Pull request title */
  title: z.string(),
  /** Current state of the PR */
  state: z.enum(['open', 'closed', 'merged']),
  /** Whether the PR is a draft */
  draft: z.boolean(),
  /** Username of the PR author */
  author: z.string(),
  /** Source branch name */
  branch: z.string(),
  /** Target branch name */
  baseBranch: z.string(),
  /** URL to the PR */
  url: z.string(),
  /** ISO timestamp when PR was created */
  createdAt: z.string(),
  /** ISO timestamp when PR was last updated */
  updatedAt: z.string(),
  /** ISO timestamp when PR was merged (null if not merged) */
  mergedAt: z.string().nullable(),
  /** Number of lines added */
  additions: z.number().optional(),
  /** Number of lines deleted */
  deletions: z.number().optional(),
  /** Number of files changed */
  changedFiles: z.number().optional(),
  /** Number of comments */
  commentCount: z.number().optional(),
  /** Number of reviews */
  reviewCount: z.number().optional(),
  /** PR head (source branch) information */
  head: z
    .object({
      /** Branch reference name */
      ref: z.string(),
      /** Commit SHA at head of PR branch */
      sha: z.string(),
    })
    .nullish(),
});

/**
 * Zod schema for a review within a PR.
 */
export const VCSReviewSchema = z.object({
  /** Unique identifier for the review */
  id: z.number(),
  /** Username of the reviewer */
  author: z.string(),
  /** Review state */
  state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'PENDING', 'DISMISSED']),
  /** Review body text */
  body: z.string().nullable(),
  /** ISO timestamp when review was submitted */
  submittedAt: z.string().nullable(),
});

/**
 * Zod schema for detailed pull request information.
 *
 * Extends the summary with additional details for PR detail views.
 */
export const VCSPullRequestDetailSchema = VCSPullRequestSchema.extend({
  /** PR description body */
  body: z.string().nullable(),
  /** Reviews associated with the PR */
  reviews: z.array(VCSReviewSchema),
  /** Labels applied to the PR */
  labels: z.array(z.string()),
  /** Users assigned to the PR */
  assignees: z.array(z.string()),
  /** Users requested for review */
  requestedReviewers: z.array(z.string()),
  /** Whether the PR can be merged (null if GitHub hasn't calculated yet) */
  mergeable: z.boolean().nullable(),
  /** Mergeable state from the VCS provider */
  mergeableState: z.string().optional(),
});

/**
 * Inferred TypeScript types.
 */
export type VCSPullRequest = z.infer<typeof VCSPullRequestSchema>;
export type VCSReview = z.infer<typeof VCSReviewSchema>;
export type VCSPullRequestDetail = z.infer<typeof VCSPullRequestDetailSchema>;
