import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { FindingTargetSchema } from '../review/schemas.js';

/**
 * Semantic meaning of a label.
 */
export const LabelSemanticSchema = z.enum(['priority', 'status', 'type', 'size', 'review', 'automation', 'custom']);
export type LabelSemantic = z.infer<typeof LabelSemanticSchema>;

/**
 * Label with optional semantic classification.
 */
export const LabelInfoSchema = z.object({
  /** Label name */
  name: z.string(),
  /** Semantic meaning (null if unclassified) */
  semantic: LabelSemanticSchema.nullable(),
});
export type LabelInfo = z.infer<typeof LabelInfoSchema>;

/**
 * Detail for a failed check run or commit status.
 */
export const CheckRunDetailSchema = z.object({
  /** Check/status ID */
  id: z.number().int().nonnegative(),
  /** Check name */
  name: z.string(),
  /** Workflow name (empty for commit statuses) */
  workflowName: z.string(),
  /** Conclusion string */
  conclusion: z.string(),
  /** Failed step name (resolved from job API, cached) */
  failedStep: z.string().nullable(),
  /** URL to view details */
  detailsUrl: z.string().url().nullable(),
  /** ISO timestamp when completed */
  completedAt: z.string().datetime().nullable(),
  /** Whether this came from a check run or commit status */
  source: z.enum(['check-run', 'commit-status']),
});
export type CheckRunDetail = z.infer<typeof CheckRunDetailSchema>;

/**
 * Aggregated checks summary combining check runs and commit statuses.
 */
export const ChecksSummarySchema = z.object({
  /** Overall status */
  status: z.enum(['pending', 'passing', 'failing', 'mixed']),
  /** Total number of checks */
  total: z.number().int().nonnegative(),
  /** Number passed */
  passed: z.number().int().nonnegative(),
  /** Number failed */
  failed: z.number().int().nonnegative(),
  /** Number pending */
  pending: z.number().int().nonnegative(),
  /** Number skipped */
  skipped: z.number().int().nonnegative(),
  /** Details of failed checks */
  failedChecks: z.array(CheckRunDetailSchema),
  /** Human-readable summary */
  summary: z.string(),
});
export type ChecksSummary = z.infer<typeof ChecksSummarySchema>;

/**
 * State of a single reviewer.
 */
export const ReviewerStateSchema = z.object({
  /** Reviewer username */
  reviewer: z.string(),
  /** Most recent review state */
  state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'PENDING', 'DISMISSED']),
  /** ISO timestamp of most recent review */
  submittedAt: z.string().datetime().nullable(),
});
export type ReviewerState = z.infer<typeof ReviewerStateSchema>;

/**
 * Aggregated reviews summary.
 */
export const ReviewsSummarySchema = z.object({
  /** Overall review status */
  status: z.enum(['pending', 'approved', 'changes-requested']),
  /** Number of approvals */
  approvals: z.number().int().nonnegative(),
  /** Number of changes-requested reviews */
  changesRequested: z.number().int().nonnegative(),
  /** Number of comment-only reviews */
  commented: z.number().int().nonnegative(),
  /** Per-reviewer state */
  reviewers: z.array(ReviewerStateSchema),
  /** Human-readable summary */
  summary: z.string(),
});
export type ReviewsSummary = z.infer<typeof ReviewsSummarySchema>;

/**
 * Aggregated findings summary.
 */
export const FindingsSummarySchema = z.object({
  /** Total findings */
  total: z.number().int().nonnegative(),
  /** Open findings */
  open: z.number().int().nonnegative(),
  /** Addressed findings */
  addressed: z.number().int().nonnegative(),
  /** Verified findings */
  verified: z.number().int().nonnegative(),
  /** Dismissed findings */
  dismissed: z.number().int().nonnegative(),
  /** Open findings broken down by severity */
  openBySeverity: z.object({
    critical: z.number().int().nonnegative(),
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
    nitpick: z.number().int().nonnegative(),
  }),
  /** Human-readable summary */
  summary: z.string(),
});
export type FindingsSummary = z.infer<typeof FindingsSummarySchema>;

/**
 * Computed readiness assessment.
 */
export const ReadinessAssessmentSchema = z.object({
  /** Overall readiness */
  status: z.enum(['ready', 'blocked', 'needs-attention']),
  /** Blocking issues (e.g., "CI failing: lint") */
  blockers: z.array(z.string()),
  /** Non-blocking warnings (e.g., "3 nitpick findings still open") */
  warnings: z.array(z.string()),
});
export type ReadinessAssessment = z.infer<typeof ReadinessAssessmentSchema>;

/**
 * Enriched pull request state aggregating all sub-states.
 */
export const PullRequestStateSchema = z.object({
  /** Repository identity (e.g., 'owner/repo') */
  repository: z.string(),
  /** PR number */
  number: z.number().int().positive(),
  /** PR title */
  title: z.string(),
  /** Source branch */
  branch: z.string(),
  /** Target branch */
  baseBranch: z.string(),
  /** PR author username */
  author: z.string(),
  /** URL to the PR */
  url: z.string().url(),
  /** PR lifecycle state */
  state: z.enum(['open', 'closed', 'merged']),
  /** Whether the PR is a draft */
  draft: z.boolean(),
  /** Whether the PR can be merged (null if not yet computed) */
  mergeable: z.boolean().nullable(),
  /** Aggregated CI/CD checks */
  checks: ChecksSummarySchema,
  /** Aggregated reviews */
  reviews: ReviewsSummarySchema,
  /** Aggregated review findings */
  findings: FindingsSummarySchema,
  /** Labels with semantic classification */
  labels: z.array(LabelInfoSchema),
  /** Computed readiness assessment */
  readiness: ReadinessAssessmentSchema,
  /** Epoch ms when this state was last synced */
  syncedAt: z.number().int().nonnegative(),
  /** Head commit SHA */
  headSha: z.string(),
});
export type PullRequestState = z.infer<typeof PullRequestStateSchema>;

/**
 * Finding target narrowed for pull request events.
 */
export const PullRequestTargetSchema = FindingTargetSchema.extend({
  /** Pull request number */
  prNumber: z.number().int().positive(),
});
export type PullRequestTarget = z.infer<typeof PullRequestTargetSchema>;

/**
 * Bus subject schemas for VCS:PR operations.
 *
 * Defines request/response and event payload shapes for all enriched
 * PR entity subjects registered under the `vcs:pr` namespace.
 */
export const VCSPRSchemas = {
  /** Get enriched PR state. Subject: `vcs:pr.get` */
  get: {
    request: z.object({
      /** Local filesystem path to the repository */
      repoPath: z.string(),
      /** Pull request number */
      prNumber: z.number().int().positive(),
    }),
    response: z.object({
      /** Enriched PR state */
      pr: PullRequestStateSchema,
    }),
  },

  /** List enriched PR states. Subject: `vcs:pr.list` */
  list: {
    request: z.object({
      /** Local filesystem path to the repository */
      repoPath: z.string(),
      /** Branch name to filter (empty for all) */
      branch: z.string().optional(),
    }),
    response: z.object({
      /** Enriched PR states */
      prs: z.array(PullRequestStateSchema),
    }),
  },

  /** Force re-sync PR state. Subject: `vcs:pr.sync` */
  sync: {
    request: z.object({
      /** Local filesystem path to the repository */
      repoPath: z.string(),
      /** Pull request number */
      prNumber: z.number().int().positive(),
    }),
    response: z.object({
      /** Updated PR state */
      pr: PullRequestStateSchema,
    }),
  },

  /** Any sub-state changed. Subject: `vcs:pr.stateChanged` */
  stateChanged: z.object({
    target: PullRequestTargetSchema,
    pr: PullRequestStateSchema,
  }),

  /** Merge conflict detected. Subject: `vcs:pr.conflicted` */
  conflicted: z.object({
    target: PullRequestTargetSchema,
  }),

  /** Checks changed. Subject: `vcs:pr.checks.changed` */
  'checks.changed': z.object({
    target: PullRequestTargetSchema,
    checks: ChecksSummarySchema,
  }),

  /** Reviews changed. Subject: `vcs:pr.reviews.changed` */
  'reviews.changed': z.object({
    target: PullRequestTargetSchema,
    reviews: ReviewsSummarySchema,
  }),

  /** Labels changed. Subject: `vcs:pr.labels.changed` */
  'labels.changed': z.object({
    target: PullRequestTargetSchema,
    labels: z.array(LabelInfoSchema),
  }),
} satisfies SchemaRecord;
