import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * Context window status after a turn completes.
 *
 * Subject: `agent.contextWindow.updated`
 * Type: Event (fire-and-forget)
 * Emitted when: After each turn completes with usage data
 *
 * Used by orchestration layer to trigger compression when thresholds are reached.
 */
export const ContextWindowUpdatedSchema = BaseAgentEventSchema.extend({
  /** Tokens in context at end of this turn (input + output = next turn's starting point) */
  currentTokens: z.number(),

  /** Model's context window limit */
  maxTokens: z.number(),

  /** Cached tokens (reduces cost but still occupies context) */
  cachedTokens: z.number().optional(),

  /** Derived: currentTokens / maxTokens * 100 */
  percentage: z.number().min(0).max(100),

  /** Derived: ok (under 60%), warn (60-80%), critical (80% or above) */
  level: z.enum(['ok', 'warn', 'critical']),
});

export type ContextWindowUpdated = z.infer<typeof ContextWindowUpdatedSchema>;
