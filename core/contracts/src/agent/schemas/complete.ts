import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';
import { ErrorCategorySchema, MessageOutcomeSchema, StructuredOutputValidationSchema } from '../../shared/index.js';

/**
 * Agent turn completed (any terminal outcome).
 *
 * Subject: `agent.complete`
 * Type: Event (fire-and-forget)
 * Emitted when: An agent finishes processing a turn — success or error.
 *
 * Consumers can inspect `outcome` to distinguish success from failure:
 * - `completed` — normal completion, `message` contains the response
 * - `error` — processing failed, `error` contains the reason
 * - `superseded` / `merged` / `cancelled` / `rejected` — non-error terminal states
 */
export const CompleteSchema = BaseAgentEventSchema.extend({
  message: z.string().optional(),
  messageId: z.string(),
  /** Terminal outcome for this turn. Omitted by some legacy emitters (interpret as 'completed'). */
  outcome: MessageOutcomeSchema.optional(),
  /** Error message when outcome is 'error'. */
  error: z.string().optional(),
  /** Error category for structured fallback/retry logic (present when outcome is 'error'). */
  errorCategory: ErrorCategorySchema.optional(),
  /**
   * Structured-output validation result for this turn.
   * Present only when a {@link ResponseSchemaDescriptor} was active during the turn.
   */
  structuredOutputValidation: StructuredOutputValidationSchema.optional(),
});

export type AgentComplete = z.infer<typeof CompleteSchema>;
