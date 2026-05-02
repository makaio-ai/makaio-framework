import { z } from 'zod';
import { usageMetadataSchema, finishReasonSchema } from './sdk-event.js';

/**
 * Session lifecycle event schemas for Gemini ACP.
 */

/**
 * Emitted when session is successfully initialized.
 */
export const InitializedEventSchema = z.object({
  type: z.literal('initialized'),
  sessionId: z.string(),
});

/**
 * Emitted when a new session is created via session/new.
 */
export const SessionCreatedEventSchema = z.object({
  type: z.literal('session_created'),
  sessionId: z.string(),
  cwd: z.string(),
  model: z.string(),
  agentId: z.string(),
  adapterId: z.string(),
  adapterName: z.string(),
});

/**
 * Emitted when a session completes processing.
 */
export const SessionCompletedEventSchema = z.object({
  type: z.literal('session_completed'),
  sessionId: z.string(),
  agentId: z.string(),
  message: z.string(),
});

/**
 * Emitted when a turn finishes with usage metadata.
 * Contains token counts and finish reason from the Gemini API.
 */
export const SessionFinishedEventSchema = z.object({
  type: z.literal('session_finished'),
  sessionId: z.string(),
  agentId: z.string(),
  model: z.string().optional(),
  reason: finishReasonSchema.optional(),
  usageMetadata: usageMetadataSchema.optional(),
});

/**
 * Emitted when an error occurs during session processing.
 */
export const SessionErrorEventSchema = z.object({
  type: z.literal('session_error'),
  sessionId: z.string(),
  agentId: z.string(),
  error: z.string(),
  status: z.number().optional(),
});

export type InitializedEvent = z.infer<typeof InitializedEventSchema>;
export type SessionCreatedEvent = z.infer<typeof SessionCreatedEventSchema>;
export type SessionCompletedEvent = z.infer<typeof SessionCompletedEventSchema>;
export type SessionFinishedEvent = z.infer<typeof SessionFinishedEventSchema>;
export type SessionErrorEvent = z.infer<typeof SessionErrorEventSchema>;
