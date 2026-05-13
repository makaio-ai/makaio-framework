import { z } from 'zod';
import { defineTool, toolSuccess, toolError } from '@makaio/tools-core';
import { SubagentErrorCode, SubagentStatusSchema, PendingRequestSchema, SubagentSubjects } from '@makaio/contracts';

/**
 * Input schema for check_subagent tool.
 */
export const CheckSubagentInputSchema = z.object({
  subagentId: z.string().describe('ID of the subagent to check'),
});

/**
 * Output schema for check_subagent tool.
 * Matches the SubagentSubjects.getStatus RPC response.
 */
export const CheckSubagentOutputSchema = z.object({
  status: SubagentStatusSchema.describe('Current status of the subagent'),
  childSessionId: z.string().optional().describe('Session ID of the child agent, set after session creation'),
  pendingRequest: PendingRequestSchema.optional().describe('Pending input request if status is waiting_input'),
  progress: z.array(z.string()).describe('Recent progress updates'),
  result: z.string().optional().describe('Result if completed successfully'),
  summary: z.string().optional().describe('Summary of the result if provided on completion'),
  error: z.string().optional().describe('Error message if failed'),
});

export type CheckSubagentInput = z.infer<typeof CheckSubagentInputSchema>;
export type CheckSubagentOutput = z.infer<typeof CheckSubagentOutputSchema>;

/**
 * Creates check_subagent tool.
 * This tool checks the current status of a spawned subagent.
 * Uses bus RPC to query SubagentService for status.
 * @returns Tool definition for check_subagent
 */
export function checkSubagentTool() {
  return defineTool({
    name: 'check_subagent',
    description:
      'Checks the current status of a spawned subagent. Returns status, ' +
      'any pending input request, recent progress updates, and result/error if terminal.',
    annotations: { readOnly: true },
    inputSchema: CheckSubagentInputSchema,
    outputSchema: CheckSubagentOutputSchema,

    execute: async (input, context) => {
      if (!context.bus) {
        return toolError(SubagentErrorCode.INVALID_STATE, 'Bus not available');
      }

      try {
        const result = await context.bus.request(SubagentSubjects.getStatus, { subagentId: input.subagentId });
        return toolSuccess(result);
      } catch (err) {
        // Service throws if subagent not found
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('not found')) {
          return toolError(SubagentErrorCode.NOT_FOUND, `Subagent '${input.subagentId}' not found`);
        }
        return toolError(SubagentErrorCode.INVALID_STATE, message);
      }
    },
  });
}
