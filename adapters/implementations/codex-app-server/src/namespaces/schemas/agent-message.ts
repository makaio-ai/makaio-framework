import { z } from 'zod';

/**
 * Schema for agent_message.delta event
 * Emitted for incremental text updates from the agent
 */
export const AgentMessageDeltaSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  delta: z.string(),
  timestamp: z.number(),
});

/**
 * Schema for agent_message event
 * Emitted when a complete agent message is ready
 */
export const AgentMessageSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  message: z.string(),
  timestamp: z.number(),
});

// Export inferred types
export type AgentMessageDelta = z.infer<typeof AgentMessageDeltaSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
