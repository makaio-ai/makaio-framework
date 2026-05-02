import { z } from 'zod';

/**
 * Base SDK message schema with common fields
 * All SDK messages extend this base schema
 */
export const BaseSdkMessageSchema = z.object({
  /** Unique message identifier */
  uuid: z.string(),

  /** Session identifier */
  session_id: z.string(),

  /** Message type (will be overridden) */
  type: z.string(),

  correlation_id: z.string().optional(),
  agentId: z.string(),

  /** ISO timestamp when the message was created */
  timestamp: z.string().optional(),

  /** Working directory where Claude Code is running */
  cwd: z.string().optional(),
});

/**
 * Base SDK message schema with parent tool tracking
 * Used for messages that can be part of a tool execution chain
 */
export const BaseSdkMessageWithParentToolSchema = BaseSdkMessageSchema.extend({
  /** Parent tool use ID if this message is part of a tool execution */
  parent_tool_use_id: z.string().nullable().optional(),
});
