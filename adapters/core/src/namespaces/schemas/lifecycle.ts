import { z } from 'zod';

/**
 * Schema for agent started event.
 * Emitted when agent begins processing a user message.
 */
export const AgentStartedEventSchema = z.object({
  eventType: z.literal('agent_started'),
  /** Model being used for this session */
  model: z.string().optional(),
});

/**
 * Schema for agent complete event.
 * Emitted when agent finishes processing (success or error).
 */
export const AgentCompleteEventSchema = z.object({
  eventType: z.literal('agent_complete'),
  /** Final assistant message content */
  message: z.string().optional(),
  /** Error message if processing failed */
  error: z.string().optional(),
});

/**
 * Schema for error event.
 * Emitted when an error occurs during processing.
 */
export const ErrorEventSchema = z.object({
  eventType: z.literal('error'),
  /** Error message */
  message: z.string(),
  /** Error code if available */
  code: z.string().or(z.number()).optional(),
  /** Error type (e.g., 'api_error', 'overloaded_error', 'validation_error') */
  type: z.string().optional(),
});

export type AgentStartedEvent = z.infer<typeof AgentStartedEventSchema>;
export type AgentCompleteEvent = z.infer<typeof AgentCompleteEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
