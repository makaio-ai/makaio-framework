import { z } from 'zod';

/**
 * Schema for tool started event.
 * Emitted when tool execution begins.
 */
export const ToolStartedEventSchema = z.object({
  eventType: z.literal('tool_started'),
  /** Name of the tool being executed */
  toolName: z.string(),
  /** Unique identifier for this tool call */
  toolCallId: z.string(),
});

/**
 * Schema for tool completed event.
 * Emitted when tool execution finishes (success or failure).
 */
export const ToolCompletedEventSchema = z.object({
  eventType: z.literal('tool_completed'),
  /** Name of the tool that was executed */
  toolName: z.string(),
  /** Unique identifier for this tool call */
  toolCallId: z.string(),
  /** Tool execution result (JSON string) */
  result: z.string(),
  /** Whether execution succeeded */
  success: z.boolean(),
});

export type ToolStartedEvent = z.infer<typeof ToolStartedEventSchema>;
export type ToolCompletedEvent = z.infer<typeof ToolCompletedEventSchema>;
