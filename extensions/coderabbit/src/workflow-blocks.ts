import { z } from 'zod';
import { getFullSubjectForSubjectDefinition } from '@makaio/bus-core';
import {
  FindingStatusSchema,
  FindingTargetSchema,
  ReviewSubjects,
  type WorkflowBlockCollection,
} from '@makaio/contracts';

/**
 * Workflow blocks contributed by the CodeRabbit extension.
 *
 * Provides trigger and step declarations for the workflow builder:
 * - Trigger: `coderabbit.review-posted` — fires when CodeRabbit submits a review
 * - Step: `coderabbit.fetch-findings` — fetches normalized findings
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
  steps: [
    {
      metadata: {
        name: 'coderabbit.fetch-findings',
        label: 'Fetch CodeRabbit Findings',
        description: 'Fetches normalized findings from the latest CodeRabbit review.',
        categories: ['review'],
      },
      configSchema: z.object({
        status: FindingStatusSchema.optional().describe(
          'Filter by lifecycle status. Leave empty to include all findings.',
        ),
      }),
      inputSchema: z.object({
        target: FindingTargetSchema,
      }),
      outputSchema: z.object({
        findings: z.array(
          z.object({
            id: z.string(),
            severity: z.enum(['critical', 'major', 'minor', 'nitpick']),
            message: z.string(),
            file: z.string().nullable(),
            startLine: z.number().nullable(),
          }),
        ),
      }),
      runs: {
        type: 'bus-request',
        subject: getFullSubjectForSubjectDefinition(ReviewSubjects.findings.list),
        payload: {
          target: '{{ input.target }}',
          status: '{{ config.status }}',
        },
      },
    },
  ],
};
