import { z } from 'zod';
import { defineTool, toolSuccess, toolError, ToolErrorCodes } from '@makaio/tools-core';
import type { BusLike } from '@makaio/tools-core';
import { VCSPRSubjects, PullRequestStateSchema } from '@makaio/contracts';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PrStatusInputSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('get'),
    pr: z.number().describe('Pull request number'),
    repoPath: z.string().optional().describe('Repository path (auto-detected from cwd if omitted)'),
  }),
  z.object({
    op: z.literal('list'),
    branch: z.string().optional().describe('Filter by branch name'),
    repoPath: z.string().optional().describe('Repository path (auto-detected from cwd if omitted)'),
  }),
  z.object({
    op: z.literal('sync'),
    pr: z.number().describe('Pull request number'),
    repoPath: z.string().optional().describe('Repository path (auto-detected from cwd if omitted)'),
  }),
]);

const PrStatusOutputSchema = z.object({
  success: z.boolean(),
  pr: PullRequestStateSchema.optional(),
  prs: z.array(PullRequestStateSchema).optional(),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * Tool for querying enriched PR state.
 *
 * Delegates to the VCS:PR aggregation service via bus subjects. Supports three
 * operations: `get` (single PR), `list` (all PRs, optional branch filter),
 * and `sync` (force re-fetch bypassing the cache).
 */
export const prStatusTool = defineTool({
  name: 'pr_status',
  description: `Get the aggregated state of a pull request including checks, reviews, findings, and readiness assessment.

Operations:
- get: Get enriched state for a specific PR
- list: List enriched states for PRs (optionally filtered by branch)
- sync: Force re-sync of PR state`,

  annotations: { readOnly: true },
  inputSchema: PrStatusInputSchema,
  outputSchema: PrStatusOutputSchema,

  execute: async (input, ctx) => {
    if (!ctx.bus) {
      return toolError(ToolErrorCodes.INTERNAL_ERROR, 'bus required');
    }

    const bus = ctx.bus as BusLike;
    const repoPath = input.repoPath ?? ctx.cwd ?? '';

    try {
      switch (input.op) {
        case 'get': {
          const { pr } = await bus.request(VCSPRSubjects.get, {
            repoPath,
            prNumber: input.pr,
          });
          return toolSuccess({ success: true, pr });
        }

        case 'list': {
          const { prs } = await bus.request(VCSPRSubjects.list, {
            repoPath,
            branch: input.branch,
          });
          return toolSuccess({ success: true, prs });
        }

        case 'sync': {
          const { pr } = await bus.request(VCSPRSubjects.sync, {
            repoPath,
            prNumber: input.pr,
          });
          return toolSuccess({ success: true, pr });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return toolError(ToolErrorCodes.INTERNAL_ERROR, message);
    }
  },
});
