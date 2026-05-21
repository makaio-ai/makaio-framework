import { z } from 'zod';
import { McpRuntimeSessionContextSchema } from '../../mcp/schemas.js';
import { BaseAgentEventSchema } from './base-event.js';
import { TurnActiveBehaviorSchema } from './model-change.js';

/**
 * Request to replace the agent's runtime MCP server context.
 *
 * Subject: `agent.mcp.servers.set`
 * Type: Request/Response
 * Sent when: Caller wants to replace dynamic SDK MCP servers mid-session
 * Handler: AIAgent swaps the connector immediately when idle, or stages the
 * latest request for the next turn boundary when requested by the caller.
 */
export const McpServersSetSchema = {
  request: BaseAgentEventSchema.extend({
    /** Replacement MCP session context for future connector construction. */
    mcpSessionContext: McpRuntimeSessionContextSchema,
    /**
     * How to handle mutation requests while a turn is active.
     *
     * - `reject`: return `{ success: false, reason: 'turn_active' }`
     * - `stageForNextTurn`: store the latest request and apply it before the next user turn dispatch
     */
    turnActiveBehavior: TurnActiveBehaviorSchema.optional(),
  }),
  response: z.object({
    /** Whether the MCP server replacement was accepted or applied. */
    success: z.boolean(),
    /** Reason for failure (only present when success is false). */
    reason: z.string().optional(),
    /** Whether the connector was rebuilt. Absent on failure. */
    swapped: z.boolean().optional(),
    /** Whether the change was accepted but deferred until the next turn boundary. */
    staged: z.boolean().optional(),
  }),
};

export type McpServersSetRequest = z.infer<typeof McpServersSetSchema.request>;
export type McpServersSetResponse = z.infer<typeof McpServersSetSchema.response>;
