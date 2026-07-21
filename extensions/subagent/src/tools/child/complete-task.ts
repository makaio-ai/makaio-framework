import { z } from 'zod';
import { defineTool, toolSuccess, toolError } from '@makaio/tools-core';
import { SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';

/**
 * Input schema for complete_task tool.
 */
export const CompleteTaskInputSchema = z.object({
  /** Final result of the task */
  result: z.string().describe('Final result of the task'),
  /** Optional summary of what was accomplished */
  summary: z.string().optional().describe('Summary of what was accomplished'),
});

/**
 * Output schema for complete_task tool.
 */
export const CompleteTaskOutputSchema = z.object({
  /** Whether the task was marked as completed */
  completed: z.boolean().describe('Whether the task was marked as completed'),
});

export type CompleteTaskInput = z.infer<typeof CompleteTaskInputSchema>;
export type CompleteTaskOutput = z.infer<typeof CompleteTaskOutputSchema>;

/**
 * Creates complete_task tool.
 * This tool allows a child subagent to signal task completion to its parent.
 * Uses bus.request() to communicate with SubagentService which owns the state.
 * @returns Tool definition for complete_task
 */
export function completeTaskTool() {
  return defineTool({
    name: 'complete_task',
    description:
      'Signals that the task is complete and provides the final result. ' +
      'Call this when the delegated work is finished.',
    inputSchema: CompleteTaskInputSchema,
    outputSchema: CompleteTaskOutputSchema,

    execute: async (input, context) => {
      if (!context.bus) {
        return toolError(SubagentErrorCode.INVALID_STATE, 'Bus not available');
      }
      if (context.sessionId === undefined) {
        return toolError(SubagentErrorCode.INVALID_STATE, 'Completion must run inside a managed session');
      }

      try {
        const result = await context.bus.request(SubagentSubjects.completeTask, {
          sessionId: context.sessionId,
          ...(context.turnId !== undefined && { turnId: context.turnId }),
          result: input.result,
          summary: input.summary,
        });
        return toolSuccess(result);
      } catch (err) {
        return toolError(SubagentErrorCode.INVALID_STATE, err instanceof Error ? err.message : String(err));
      }
    },
  });
}
