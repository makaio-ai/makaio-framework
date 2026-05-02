import { z } from 'zod';
import { defineTool, toolSuccess, toolError } from '@makaio/tools-core';
import { SubagentErrorCode, PendingRequestSchema, SubagentSubjects } from '@makaio/contracts';

/**
 * Input schema for await_subagent tool.
 */
export const AwaitSubagentInputSchema = z.object({
  subagentId: z.string().describe('ID of the subagent to await'),
  timeoutMs: z.number().optional().describe('Timeout in milliseconds (default: from service constraints)'),
});

/**
 * Possible status values returned by await_subagent.
 */
export const AwaitStatusSchema = z.enum(['completed', 'failed', 'waiting_input', 'timeout', 'cancelled']);

/**
 * Output schema for await_subagent tool.
 * Matches the SubagentSubjects.await RPC response.
 */
export const AwaitSubagentOutputSchema = z.object({
  status: AwaitStatusSchema.describe('Status when await returned'),
  result: z.string().optional().describe('Result if completed successfully'),
  pendingRequest: PendingRequestSchema.optional().describe('Pending input request if status is waiting_input'),
  error: z.string().optional().describe('Error message if failed'),
});

export type AwaitSubagentInput = z.infer<typeof AwaitSubagentInputSchema>;
export type AwaitSubagentOutput = z.infer<typeof AwaitSubagentOutputSchema>;

/**
 * Creates await_subagent tool.
 * This tool blocks until a subagent completes, fails, or times out.
 * Uses bus RPC to delegate await logic to SubagentService.
 * @returns Tool definition for await_subagent
 */
export function awaitSubagentTool() {
  return defineTool({
    name: 'await_subagent',
    description:
      'Blocks until a subagent reaches a terminal state (completed, failed, cancelled), ' +
      'needs input (waiting_input), or times out. Returns immediately if already ' +
      'in one of these states.',
    inputSchema: AwaitSubagentInputSchema,
    outputSchema: AwaitSubagentOutputSchema,

    execute: async (input, context) => {
      if (!context.bus) {
        return toolError(SubagentErrorCode.INVALID_STATE, 'Bus not available');
      }

      try {
        const result = await context.bus.request(SubagentSubjects.await, {
          subagentId: input.subagentId,
          timeoutMs: input.timeoutMs,
        });
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
