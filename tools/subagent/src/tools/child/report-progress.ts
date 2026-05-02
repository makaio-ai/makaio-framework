import { z } from 'zod';
import { defineTool, toolSuccess, toolError } from '@makaio/tools-core';
import { SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';

/**
 * Input schema for report_progress tool.
 */
export const ReportProgressInputSchema = z.object({
  /** Progress update message */
  update: z.string().describe('Progress update message'),
  /** Optional completion percentage (0-100) */
  percentComplete: z.number().min(0).max(100).optional().describe('Completion percentage (0-100)'),
});

/**
 * Output schema for report_progress tool.
 */
export const ReportProgressOutputSchema = z.object({
  /** Whether the progress was reported successfully */
  reported: z.boolean().describe('Whether the progress was reported'),
});

export type ReportProgressInput = z.infer<typeof ReportProgressInputSchema>;
export type ReportProgressOutput = z.infer<typeof ReportProgressOutputSchema>;

/**
 * Creates report_progress tool.
 * This tool allows a child subagent to report progress updates to its parent.
 * Uses bus.request() to communicate with SubagentService which owns the state.
 * @returns Tool definition for report_progress
 */
export function reportProgressTool() {
  return defineTool({
    name: 'report_progress',
    description:
      'Reports a progress update to the parent agent. ' + 'Use this to keep the parent informed of task progress.',
    inputSchema: ReportProgressInputSchema,
    outputSchema: ReportProgressOutputSchema,

    execute: async (input, context) => {
      if (!context.bus) {
        return toolError(SubagentErrorCode.INVALID_STATE, 'Bus not available');
      }
      if (!context.subagentId) {
        return toolError(SubagentErrorCode.INVALID_STATE, 'Not running as a subagent');
      }

      try {
        const result = await context.bus.request(SubagentSubjects.reportProgress, {
          subagentId: context.subagentId,
          update: input.update,
          percentComplete: input.percentComplete,
        });
        return toolSuccess(result);
      } catch (err) {
        return toolError(SubagentErrorCode.INVALID_STATE, err instanceof Error ? err.message : String(err));
      }
    },
  });
}
