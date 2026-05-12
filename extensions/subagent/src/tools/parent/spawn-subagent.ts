import { z } from 'zod';
import { defineTool, toolSuccess, toolError } from '@makaio/tools-core';
import { SubagentConfigSchema, SubagentError, SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';

/**
 * Input schema for spawn_subagent tool.
 * Uses SubagentConfigSchema from contracts for the config fields.
 */
export const SpawnSubagentInputSchema = SubagentConfigSchema;

/**
 * Output schema for spawn_subagent tool.
 *
 * Note: childSessionId is not returned - session is created asynchronously
 * by SubagentService. Use check_subagent to get childSessionId after spawn.
 */
export const SpawnSubagentOutputSchema = z.object({
  subagentId: z.string().describe('Unique identifier for the spawned subagent'),
  status: z.literal('spawning').describe('Initial status - session creation in progress'),
});

export type SpawnSubagentInput = z.infer<typeof SpawnSubagentInputSchema>;
export type SpawnSubagentOutput = z.infer<typeof SpawnSubagentOutputSchema>;

/**
 * Creates spawn_subagent tool.
 * This tool spawns a new subagent to perform a delegated task.
 * Uses bus RPC to delegate all state management to SubagentService.
 * @returns Tool definition for spawn_subagent
 */
export function spawnSubagentTool() {
  return defineTool({
    name: 'spawn_subagent',
    description:
      'Spawns a new subagent to perform a delegated task. The subagent runs ' +
      'independently and can be monitored, sent messages, or terminated. ' +
      'Use for parallelizable subtasks or when task isolation is needed.',
    inputSchema: SpawnSubagentInputSchema,
    outputSchema: SpawnSubagentOutputSchema,

    execute: async (input, context) => {
      if (!context.bus) {
        return toolError(SubagentErrorCode.INVALID_STATE, 'Bus not available');
      }

      const parentSessionId = context.sessionId;
      if (!parentSessionId) {
        return toolError(SubagentErrorCode.INVALID_STATE, 'Cannot spawn subagent: no session ID in context');
      }

      const depth = (context.subagentDepth ?? 0) + 1;

      try {
        const result = await context.bus.requestOptional(SubagentSubjects.spawn, {
          parentSessionId,
          config: input,
          depth,
          ...(context.toolCallId !== undefined && { spawningToolCallId: context.toolCallId }),
        });
        if (!result.handled) {
          return toolError(SubagentErrorCode.INVALID_STATE, 'Subagent system not available');
        }
        return toolSuccess(result.data);
      } catch (err) {
        // Preserve specific error codes from SubagentError
        const code = err instanceof SubagentError ? err.code : SubagentErrorCode.INVALID_STATE;
        const message = err instanceof Error ? err.message : String(err);
        return toolError(code, message);
      }
    },
  });
}
