import { z } from 'zod';

/**
 * Turn state schema for Gemini connector.
 * Simpler than Claude - no 'paused' state (abort+restart instead).
 */
export const GeminiTurnStateSchema = z.enum(['idle', 'turn_started', 'step_started', 'step_finished', 'turn_finished']);

export type GeminiTurnState = z.infer<typeof GeminiTurnStateSchema>;

/** Turn state change event */
export const TurnStateChangedSchema = z.object({
  adapterId: z.string(),
  agentId: z.string(),
  oldState: GeminiTurnStateSchema,
  newState: GeminiTurnStateSchema,
  timestamp: z.number(),
});

export type TurnStateChanged = z.infer<typeof TurnStateChangedSchema>;
