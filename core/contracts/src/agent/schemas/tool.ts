import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * Tool use requested by agent.
 *
 * Subject: `agent.tool.use`
 * Type: Event (fire-and-forget)
 * Emitted when: Agent requests to use a tool
 */
export const ToolUseSchema = BaseAgentEventSchema.extend({
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  toolCallId: z.string(),
});

/**
 * Tool execution started.
 *
 * Subject: `agent.tool.started`
 * Type: Event (fire-and-forget)
 * Emitted when: A tool begins execution
 */
export const ToolStartedSchema = BaseAgentEventSchema.extend({
  toolName: z.string(),
  toolCallId: z.string(),
});

/**
 * Tool execution output received.
 *
 * Subject: `agent.tool.output`
 * Type: Event (fire-and-forget)
 * Emitted when: A tool produces output during execution
 */
export const ToolOutputSchema = BaseAgentEventSchema.extend({
  output: z.string(),
  toolCallId: z.string(),
  toolName: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Tool execution completed.
 *
 * Subject: `agent.tool.completed`
 * Type: Event (fire-and-forget)
 * Emitted when: A tool finishes execution
 */
export const ToolCompletedSchema = BaseAgentEventSchema.extend({
  toolName: z.string(),
  /** Tool arguments from the original tool.use call. Optional for backward compatibility. */
  args: z.record(z.string(), z.unknown()).optional(),
  result: z
    .record(z.string(), z.unknown())
    .or(z.string())
    .or(z.array(z.record(z.string(), z.unknown()))),
  success: z.boolean().optional(),
  toolCallId: z.string(),
});

export type ToolUse = z.infer<typeof ToolUseSchema>;
export type ToolStarted = z.infer<typeof ToolStartedSchema>;
export type ToolOutput = z.infer<typeof ToolOutputSchema>;
export type ToolCompleted = z.infer<typeof ToolCompletedSchema>;
