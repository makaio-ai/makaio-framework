import { z } from 'zod';
import { defineTool, toolSuccess, toolError } from '@makaio/tools-core';
import { SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';

/**
 * Input schema for kill_subagent tool.
 */
export const KillSubagentInputSchema = z.object({
  subagentId: z.string().describe('ID of the subagent to terminate'),
  reason: z.string().optional().describe('Reason for termination'),
});

/**
 * Output schema for kill_subagent tool.
 * Matches the SubagentSubjects.kill RPC response.
 */
export const KillSubagentOutputSchema = z.object({
  killed: z.boolean().describe('Whether the subagent was successfully terminated'),
});

export type KillSubagentInput = z.infer<typeof KillSubagentInputSchema>;
export type KillSubagentOutput = z.infer<typeof KillSubagentOutputSchema>;

/**
 * Creates kill_subagent tool.
 * This tool terminates a running subagent.
 * Uses bus RPC to delegate termination to SubagentService.
 * @returns Tool definition for kill_subagent
 */
export function killSubagentTool() {
  return defineTool({
    name: 'kill_subagent',
    description:
      'Terminates a running subagent. Returns killed=true if successful, ' +
      'killed=false if the subagent was already in a terminal state or not found.',
    inputSchema: KillSubagentInputSchema,
    outputSchema: KillSubagentOutputSchema,

    execute: async (input, context) => {
      if (!context.bus) {
        return toolError(SubagentErrorCode.INVALID_STATE, 'Bus not available');
      }

      try {
        const result = await context.bus.requestOptional(SubagentSubjects.kill, {
          subagentId: input.subagentId,
          reason: input.reason,
        });
        // Best-effort cleanup: if the subagent system is not registered, treat
        // as a no-op kill (killed=false) rather than failing the tool.
        return toolSuccess(result.handled ? result.data : { killed: false });
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
