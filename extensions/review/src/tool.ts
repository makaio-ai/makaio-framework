import { z } from 'zod';
import { defineTool, toolSuccess, toolError, ToolErrorCodes } from '@makaio/tools-core';
import type { BusLike, ToolResult } from '@makaio/tools-core';
import { ReviewSubjects, FindingStatusSchema, ReviewFindingSchema, FindingTargetSchema } from '@makaio/contracts';

/**
 * Discriminated-union input schema for the review_findings tool.
 *
 * Each operation maps to a ReviewSubjects handler on the bus:
 * - `list`          → review.findings.list
 * - `fetch`         → review.findings.fetch
 * - `start`         → review.start
 * - `update_status` → review.finding.updateStatus
 * - `submit`        → review.findings.submit
 * - `sources`       → review.source.list
 */
const ReviewFindingsInputSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('list'),
    /** Pull request number to list findings for. */
    pr: z.number().describe('Pull request number'),
    /** Filter by lifecycle status. */
    status: FindingStatusSchema.optional().describe('Filter by status'),
    /** Local repository path; falls back to tool execution cwd. */
    repoPath: z.string().optional().describe('Local repository path'),
  }),
  z.object({
    op: z.literal('fetch'),
    /** Pull request number to fetch findings for. */
    pr: z.number().describe('Pull request number'),
    /** Local repository path; falls back to tool execution cwd. */
    repoPath: z.string().optional().describe('Local repository path'),
  }),
  z.object({
    op: z.literal('start'),
    /** Pull request number to trigger review for. */
    pr: z.number().describe('Pull request number'),
    /** Specific source ID to trigger (optional; uses first triggerable source). */
    sourceId: z.string().optional().describe('Source ID to trigger'),
    /** Local repository path; falls back to tool execution cwd. */
    repoPath: z.string().optional().describe('Local repository path'),
  }),
  z.object({
    op: z.literal('update_status'),
    /** ID of the finding to update. */
    findingId: z.string().describe('Finding ID'),
    /** New lifecycle status. */
    status: FindingStatusSchema.describe('New status'),
    /** Reason for dismissal or deferral. */
    reason: z.string().optional().describe('Reason for dismissal/deferral'),
    /** Commit SHA or description of how it was addressed. */
    addressedBy: z.string().optional().describe('How the finding was addressed'),
    /** Pull request number (required for target resolution). */
    pr: z.number().describe('Pull request number'),
    /** Local repository path; falls back to tool execution cwd. */
    repoPath: z.string().optional().describe('Local repository path'),
  }),
  z.object({
    op: z.literal('submit'),
    /** Finding to submit (agent-produced). */
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
    /** Local repository path; falls back to tool execution cwd. */
    repoPath: z.string().optional().describe('Local repository path'),
  }),
  z.object({
    op: z.literal('sources'),
  }),
]);

const ReviewFindingsOutputSchema = z.object({
  /** Human-readable result summary. */
  summary: z.string(),
  /** Findings returned by the operation (list/fetch). */
  findings: z.array(ReviewFindingSchema).optional(),
  /** Available review sources (sources). */
  sources: z
    .array(
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
    )
    .optional(),
  /** Result of a start operation. */
  triggered: z.boolean().optional(),
  /** Result of an update_status operation. */
  success: z.boolean().optional(),
  /** Updated finding after update_status. */
  finding: ReviewFindingSchema.optional(),
  /** Finding submitted by submit operation. */
  submitted: ReviewFindingSchema.optional(),
});

/**
 * Builds a FindingTarget from a PR number and repository path.
 *
 * The repository field is populated with the resolved repoPath so that
 * VCS providers can route the request correctly.
 * @param pr - Pull request number
 * @param repoPath - Local repository path (used as repository identity)
 * @returns Minimal FindingTarget for bus requests
 */
function buildTarget(pr: number, repoPath: string): z.infer<typeof FindingTargetSchema> {
  return { repository: repoPath, prNumber: pr };
}

type ReviewFindingsInput = z.infer<typeof ReviewFindingsInputSchema>;
type ReviewFindingsOutput = z.infer<typeof ReviewFindingsOutputSchema>;

/**
 * Dispatches a validated review_findings tool input to the appropriate bus handler.
 * @param input - Validated discriminated-union input
 * @param bus - Bus instance for subject requests
 * @param cwd - Tool execution working directory for repoPath fallback
 * @returns Typed tool result
 */
async function dispatch(
  input: ReviewFindingsInput,
  bus: BusLike,
  cwd: string,
): Promise<ToolResult<ReviewFindingsOutput>> {
  switch (input.op) {
    case 'list': {
      const repoPath = input.repoPath ?? cwd;
      const target = buildTarget(input.pr, repoPath);
      const { findings } = await bus.request(ReviewSubjects.findings.list, { target, status: input.status });
      return toolSuccess({ summary: `Found ${findings.length} finding(s) for PR #${input.pr}`, findings });
    }
    case 'fetch': {
      const repoPath = input.repoPath ?? cwd;
      const target = buildTarget(input.pr, repoPath);
      const { findings, created, updated } = await bus.request(ReviewSubjects.findings.fetch, { target, repoPath });
      return toolSuccess({
        summary: `Fetched findings for PR #${input.pr}: ${created} new, ${updated} updated`,
        findings,
      });
    }
    case 'start': {
      const repoPath = input.repoPath ?? cwd;
      const target = buildTarget(input.pr, repoPath);
      const { triggered, estimatedDelayMs, rateLimit } = await bus.request(ReviewSubjects.start, {
        target,
        repoPath,
        sourceId: input.sourceId,
      });
      const delayInfo =
        triggered && estimatedDelayMs !== undefined
          ? ` (estimated delay: ${Math.round(estimatedDelayMs / 1000)}s)`
          : '';
      const rateLimitInfo =
        rateLimit !== null && !triggered ? ` Rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining` : '';
      return toolSuccess({
        summary: triggered
          ? `Review triggered for PR #${input.pr}${delayInfo}`
          : `Could not trigger review for PR #${input.pr}${rateLimitInfo}`,
        triggered,
      });
    }
    case 'update_status': {
      const repoPath = input.repoPath ?? cwd;
      const target = buildTarget(input.pr, repoPath);
      const { success, finding } = await bus.request(ReviewSubjects.finding.updateStatus, {
        findingId: input.findingId,
        target,
        status: input.status,
        reason: input.reason,
        addressedBy: input.addressedBy,
      });
      return toolSuccess({
        summary: success
          ? `Finding ${input.findingId} updated to status: ${input.status}`
          : `Finding ${input.findingId} was not updated`,
        success,
        finding,
      });
    }
    case 'submit': {
      const { finding } = await bus.request(ReviewSubjects.findings.submit, { finding: input.finding });
      return toolSuccess({ summary: `Finding submitted: ${finding.id}`, submitted: finding });
    }
    case 'sources': {
      const { sources } = await bus.request(ReviewSubjects.source.list, {});
      return toolSuccess({ summary: `${sources.length} review source(s) available`, sources });
    }
  }
}

/**
 * Tool for managing review findings produced by external reviewers and agents.
 *
 * Supports listing, fetching, triggering, updating status, submitting, and
 * listing available sources. All operations are delegated to the review service
 * via the bus.
 */
export const reviewFindingsTool = defineTool({
  name: 'review_findings',
  description: `Manage review findings from external code reviewers and agents.

Operations:
- list: List stored findings for a PR (optionally filtered by status)
- fetch: Fetch fresh findings from external sources and reconcile with storage
- start: Trigger a review (e.g., post a review comment to a bot)
- update_status: Transition a finding lifecycle status (open/addressed/verified/dismissed/deferred)
- submit: Submit an agent-produced finding
- sources: List available review sources and their current rate limits`,

  annotations: {
    readOnly: false,
  },

  inputSchema: ReviewFindingsInputSchema,
  outputSchema: ReviewFindingsOutputSchema,

  execute: async (input, ctx) => {
    if (!ctx.bus) {
      return toolError(ToolErrorCodes.INTERNAL_ERROR, 'bus required for review_findings');
    }
    return dispatch(input, ctx.bus, ctx.cwd);
  },
});
