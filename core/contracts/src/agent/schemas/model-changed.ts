import { z } from 'zod';
import { AIReasoningLevelSchema } from '../../model/index.js';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * Agent model changed during execution.
 *
 * Subject: `agent.model.changed`
 * Type: Event (fire-and-forget)
 * Emitted when: The model is changed mid-session (e.g., user switches models)
 * Use for: Tracking model transitions for billing, context restoration
 */
export const ModelChangedSchema = BaseAgentEventSchema.extend({
  /** Previous model identifier */
  previousModel: z.string(),
  /** New model identifier */
  newModel: z.string(),
  /** Reasoning effort level before the change. Absent when reasoning was not configured. */
  previousReasoningEffort: AIReasoningLevelSchema.optional(),
  /** Reasoning effort level after the change. Absent when reasoning is not configured. */
  newReasoningEffort: AIReasoningLevelSchema.optional(),
});

export type ModelChanged = z.infer<typeof ModelChangedSchema>;
