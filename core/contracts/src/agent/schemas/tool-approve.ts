import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * Request approval for tool execution.
 *
 * Subject: `agent.toolApprove`
 * Type: Request (RPC)
 * Emitted when: Agent requires approval before executing a tool
 *
 * Response semantics:
 * - `action: 'allow'`: Approve tool execution
 *   - `updatedInput`: Optional modified arguments (e.g., user corrected a path)
 *   - `updatedPermissions`: Optional permission updates (e.g., "always allow" this pattern)
 * - `action: 'deny'`: Reject tool execution
 *   - `message`: Required explanation or guidance for the agent
 *   - `shouldAbort`: If true, stop execution entirely; if false/unset, agent may retry
 */
export const AgentToolApproveSchema = {
  request: BaseAgentEventSchema.extend({
    /** Makaio session ID — required for approval routing to the owning tab. */
    sessionId: z.string(),
    toolName: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    toolCallId: z.string(),
    /** LLM reasoning/thinking that preceded this tool call (when available) */
    reasoning: z.string().optional(),
  }),
  response: z.discriminatedUnion('action', [
    z.object({
      action: z.literal('allow'),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      updatedPermissions: z.array(z.unknown()).optional(),
    }),
    z.object({
      action: z.literal('deny'),
      message: z.string(),
      shouldAbort: z.boolean().optional(),
    }),
  ]),
};

export type AgentToolApproveRequest = z.infer<typeof AgentToolApproveSchema.request>;
export type AgentToolApproveResponse = z.infer<typeof AgentToolApproveSchema.response>;
