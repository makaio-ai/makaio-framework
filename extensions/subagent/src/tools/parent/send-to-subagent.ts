import { z } from 'zod';
import { defineTool, toolSuccess, toolError } from '@makaio/tools-core';
import { SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';

/**
 * Input schema for send_to_subagent tool.
 */
export const SendToSubagentInputSchema = z.object({
  subagentId: z.string().describe('ID of the subagent to send message to'),
  content: z.string().describe('Message content to send'),
  inResponseTo: z.string().optional().describe('Message ID of the pending request this responds to'),
});

/**
 * Output schema for send_to_subagent tool.
 * Matches the SubagentSubjects.send RPC response.
 */
export const SendToSubagentOutputSchema = z.object({
  sent: z.boolean().describe('Whether the message was successfully sent'),
  resolvedPending: z.boolean().describe('Whether a pending input request was resolved'),
});

export type SendToSubagentInput = z.infer<typeof SendToSubagentInputSchema>;
export type SendToSubagentOutput = z.infer<typeof SendToSubagentOutputSchema>;

/**
 * Creates send_to_subagent tool.
 * This tool sends a message or response to a subagent.
 * Uses bus RPC to delegate message delivery to SubagentService.
 * @returns Tool definition for send_to_subagent
 */
export function sendToSubagentTool() {
  return defineTool({
    name: 'send_to_subagent',
    description:
      'Sends a message or response to a subagent. If inResponseTo is provided ' +
      'and matches a pending request_input, the subagent will be unblocked ' +
      'and resume execution with your response.',
    inputSchema: SendToSubagentInputSchema,
    outputSchema: SendToSubagentOutputSchema,

    execute: async (input, context) => {
      if (!context.bus) {
        return toolError(SubagentErrorCode.INVALID_STATE, 'Bus not available');
      }

      try {
        const result = await context.bus.request(SubagentSubjects.send, {
          subagentId: input.subagentId,
          content: input.content,
          inResponseTo: input.inResponseTo,
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
