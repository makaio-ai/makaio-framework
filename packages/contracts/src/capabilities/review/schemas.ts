import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

// -- Shared entity schemas --

/**
 * Lifecycle states for a review finding.
 */
export const FindingStatusSchema = z.enum(['open', 'addressed', 'verified', 'dismissed', 'deferred']);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

/**
 * Impact level for a review finding.
 */
export const FindingSeveritySchema = z.enum(['critical', 'major', 'minor', 'nitpick']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/**
 * How the finding was produced.
 */
export const FindingOriginSchema = z.enum(['inline', 'review-body', 'issue-comment', 'cli-output', 'agent']);
export type FindingOrigin = z.infer<typeof FindingOriginSchema>;

/**
 * A structured code replacement suggestion attached to a finding.
 */
export const SuggestedChangeSchema = z.object({
  /** File path the suggestion applies to */
  file: z.string(),
  /** Original code to replace */
  oldCode: z.string(),
  /** Replacement code */
  newCode: z.string(),
});
export type SuggestedChange = z.infer<typeof SuggestedChangeSchema>;

/**
 * Identity of the repository/PR/branch a finding targets.
 */
export const FindingTargetSchema = z.object({
  /** Repository identity (e.g., 'owner/repo') */
  repository: z.string(),
  /** Pull request number */
  prNumber: z.number().optional(),
  /** Branch name */
  branch: z.string().optional(),
  /** Head commit SHA */
  headSha: z.string().optional(),
});
export type FindingTarget = z.infer<typeof FindingTargetSchema>;

/**
 * A single review finding persisted by the review service.
 */
export const ReviewFindingSchema = z.object({
  /** Stable finding identity */
  id: z.string(),
  /** Target repository/PR/branch */
  target: FindingTargetSchema,
  /** Source that produced this finding */
  sourceId: z.string(),
  /** Reviewer family (e.g., 'coderabbit', 'copilot') */
  reviewer: z.string(),
  /** How the finding was produced */
  origin: FindingOriginSchema,
  /** Thread ID for inline comments */
  threadId: z.string().nullable(),
  /** Impact level */
  severity: FindingSeveritySchema,
  /** File path (null for architectural findings) */
  file: z.string().nullable(),
  /** Starting line number */
  startLine: z.number().nullable(),
  /** Ending line number */
  endLine: z.number().nullable(),
  /** Description of the finding */
  message: z.string(),
  /** AI-optimized agent prompt */
  agentPrompt: z.string().nullable(),
  /** Structured code suggestions */
  suggestedChanges: z.array(SuggestedChangeSchema),
  /** Current lifecycle status */
  status: FindingStatusSchema,
  /** Commit SHA or description of how it was addressed */
  addressedBy: z.string().nullable(),
  /** Timestamp when addressed */
  addressedAt: z.number().nullable(),
  /** Timestamp when externally verified */
  verifiedAt: z.number().nullable(),
  /** Reason for dismissal or deferral */
  dismissedReason: z.string().nullable(),
  /** Creation timestamp (epoch ms) */
  createdAt: z.number(),
  /** Last update timestamp (epoch ms) */
  updatedAt: z.number(),
  /** Raw VCS comment ID for reply/resolve operations */
  rawCommentId: z.number().nullable(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/**
 * Rate-limit state for a single review source.
 */
export const ReviewSourceRateLimitSchema = z.object({
  /** Source that this rate limit applies to */
  sourceId: z.string(),
  /** Remaining review triggers */
  remaining: z.number(),
  /** Total limit */
  limit: z.number(),
  /** Epoch ms when limit resets */
  resetsAt: z.number(),
  /** Epoch ms when this was last updated */
  lastUpdatedAt: z.number(),
});
export type ReviewSourceRateLimit = z.infer<typeof ReviewSourceRateLimitSchema>;

/**
 * An issue-level comment from a VCS issue timeline.
 */
export const ReviewIssueCommentSchema = z.object({
  /** Comment ID */
  id: z.union([z.number(), z.string()]),
  /** Author username */
  author: z.string(),
  /** Comment body */
  body: z.string(),
  /** URL to the comment */
  url: z.string().nullable(),
  /** ISO timestamp when created */
  createdAt: z.string().nullable(),
  /** ISO timestamp when updated */
  updatedAt: z.string().nullable(),
});
export type ReviewIssueComment = z.infer<typeof ReviewIssueCommentSchema>;

// -- Bus subject schemas --

/**
 * Bus subject schemas for the review capability namespace.
 *
 * Each key maps to a subject name (prefixed with `review.` by the namespace
 * registration). Events are bare Zod schemas; RPC subjects carry
 * `{ request, response }` pairs.
 */
export const ReviewSchemas = {
  /**
   * Source announces itself.
   *
   * Subject: `review.source.registered`
   */
  'source.registered': z.object({
    sourceId: z.string(),
    reviewer: z.string(),
    displayName: z.string(),
  }),

  /**
   * List available sources and their rate limits.
   *
   * Subject: `review.source.list`
   */
  'source.list': {
    request: z.object({}),
    response: z.object({
      sources: z.array(
        z.object({
          sourceId: z.string(),
          reviewer: z.string(),
          displayName: z.string(),
          capabilities: z.object({
            canTrigger: z.boolean(),
            canFetch: z.boolean(),
            isPush: z.boolean(),
          }),
          processorKey: z.string().nullable(),
          shadowedProcessors: z.array(z.string()).optional(),
        }),
      ),
      rateLimits: z.array(ReviewSourceRateLimitSchema),
    }),
  },

  /**
   * Trigger a review.
   *
   * Subject: `review.start`
   */
  start: {
    request: z.object({
      target: FindingTargetSchema,
      repoPath: z.string(),
      sourceId: z.string().optional(),
    }),
    response: z.object({
      triggered: z.boolean(),
      estimatedDelayMs: z.number().optional(),
      rateLimit: ReviewSourceRateLimitSchema.nullable(),
    }),
  },

  /**
   * Review was triggered.
   *
   * Subject: `review.started`
   */
  started: z.object({
    target: FindingTargetSchema,
    sourceId: z.string(),
  }),

  /**
   * Fetch findings from external sources.
   *
   * Subject: `review.findings.fetch`
   */
  'findings.fetch': {
    request: z.object({
      target: FindingTargetSchema,
      repoPath: z.string(),
    }),
    response: z.object({
      findings: z.array(ReviewFindingSchema),
      created: z.number(),
      updated: z.number(),
    }),
  },

  /**
   * List stored findings.
   *
   * Subject: `review.findings.list`
   */
  'findings.list': {
    request: z.object({
      target: FindingTargetSchema,
      status: FindingStatusSchema.optional(),
    }),
    response: z.object({
      findings: z.array(ReviewFindingSchema),
    }),
  },

  /**
   * New/updated findings available.
   *
   * Subject: `review.findings.arrived`
   */
  'findings.arrived': z.object({
    target: FindingTargetSchema,
    created: z.number(),
    updated: z.number(),
  }),

  /**
   * Submit an agent-produced finding.
   *
   * Subject: `review.findings.submit`
   */
  'findings.submit': {
    request: z.object({
      finding: ReviewFindingSchema.omit({
        createdAt: true,
        updatedAt: true,
        verifiedAt: true,
        addressedAt: true,
        addressedBy: true,
      }).extend({
        createdAt: z.number().optional(),
        updatedAt: z.number().optional(),
      }),
    }),
    response: z.object({
      finding: ReviewFindingSchema,
    }),
  },

  /**
   * Update finding lifecycle status.
   *
   * Subject: `review.finding.updateStatus`
   */
  'finding.updateStatus': {
    request: z.object({
      findingId: z.string(),
      target: FindingTargetSchema,
      status: FindingStatusSchema,
      reason: z.string().optional(),
      addressedBy: z.string().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      finding: ReviewFindingSchema,
    }),
  },

  /**
   * Finding status changed.
   *
   * Subject: `review.finding.statusChanged`
   */
  'finding.statusChanged': z.object({
    finding: ReviewFindingSchema,
    previousStatus: FindingStatusSchema,
  }),

  /**
   * Source rate limit changed.
   *
   * Subject: `review.source.rateLimitChanged`
   */
  'source.rateLimitChanged': z.object({
    rateLimit: ReviewSourceRateLimitSchema,
  }),
} satisfies SchemaRecord;
