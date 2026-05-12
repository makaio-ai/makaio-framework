import { z } from 'zod';
import { defineTool, toolSuccess, toolError } from '@makaio/tools-core';
import { SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';

/**
 * Input schema for request_input tool.
 */
export const RequestInputInputSchema = z.object({
  /** Question to ask the parent */
  question: z.string().describe('Question to ask the parent agent'),
  /** Optional additional context for the question */
  context: z.string().optional().describe('Additional context for the question'),
  /** Timeout in milliseconds (defaults to constraint default) */
  timeoutMs: z.number().optional().describe('Timeout in milliseconds'),
});

/**
 * Output schema for request_input tool.
 */
export const RequestInputOutputSchema = z.object({
  /** Whether the parent responded */
  responded: z.boolean().describe('Whether the parent responded'),
  /** The response from the parent, if any */
  response: z.string().optional().describe('Response from the parent'),
  /** Whether the request timed out */
  timedOut: z.boolean().describe('Whether the request timed out'),
});

export type RequestInputInput = z.infer<typeof RequestInputInputSchema>;
export type RequestInputOutput = z.infer<typeof RequestInputOutputSchema>;

/**
 * Creates request_input tool.
 * This tool allows a child subagent to ask the parent a blocking question.
 * Uses bus.request() to communicate with SubagentService which owns the state.
 * @returns Tool definition for request_input
 */
export function requestInputTool() {
  return defineTool({
    name: 'request_input',
    description:
      'Asks the parent agent a blocking question and waits for a response. ' +
      'Use when you need clarification or input to proceed.',
    inputSchema: RequestInputInputSchema,
    outputSchema: RequestInputOutputSchema,

    execute: async (input, context) => {
      if (!context.bus) {
        return toolError(SubagentErrorCode.INVALID_STATE, 'Bus not available');
      }
      if (!context.subagentId) {
        return toolError(SubagentErrorCode.INVALID_STATE, 'Not running as a subagent');
      }

      try {
        const result = await context.bus.request(SubagentSubjects.requestInput, {
          subagentId: context.subagentId,
          question: input.question,
          context: input.context,
          timeoutMs: input.timeoutMs,
        });
        return toolSuccess(result);
      } catch (err) {
        return toolError(SubagentErrorCode.INVALID_STATE, err instanceof Error ? err.message : String(err));
      }
    },
  });
}
