import { z } from 'zod';
import { FindingTargetSchema, type WorkflowBlockCollection } from '@makaio/contracts';

/**
 * Workflow blocks contributed by the CodeRabbit extension.
 *
 * Provides trigger declarations for the workflow builder:
 * - Trigger: `coderabbit.review-posted` — fires when CodeRabbit submits a review
 *
 * Finding fetches are exposed through review capabilities, not workflow roles.
 * Role-backed workflow steps must resolve through `WorkflowSubjects.resolveRole`
 * before execution; this extension does not register a CodeRabbit workflow role
 * resolver, so it must not publish a role-backed findings fetcher step.
 */
export const codeRabbitBlocks: WorkflowBlockCollection = {
  triggers: [
    {
      metadata: {
        name: 'coderabbit.review-posted',
        label: 'CodeRabbit Review Posted',
        description: 'Fires when CodeRabbit submits a review on a PR.',
        categories: ['review', 'vcs'],
      },
      configSchema: z.object({
        repository: z.string().optional().describe('Filter to specific repo (glob). Leave empty for all.'),
        minSeverity: z
          .enum(['critical', 'major', 'minor', 'nitpick'])
          .default('minor')
          .describe('Minimum finding severity to trigger.'),
      }),
      outputSchema: z.object({
        target: FindingTargetSchema,
        findingCount: z.number(),
        severityCounts: z.object({
          critical: z.number(),
          major: z.number(),
          minor: z.number(),
          nitpick: z.number(),
        }),
      }),
    },
  ],
  steps: [],
};
