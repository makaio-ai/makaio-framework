import { z } from 'zod';

/**
 * Turn state schema for GitHub Copilot connector.
 * Similar to Gemini - no 'paused' state (abort+restart instead).
 */
export const CopilotTurnStateSchema = z.enum([
  'idle',
  'turn_started',
  'step_started',
  'step_finished',
  'turn_finished',
]);

export type CopilotTurnState = z.infer<typeof CopilotTurnStateSchema>;

/** Turn state change event */
export const TurnStateChangedSchema = z.object({
  adapterId: z.string(),
  agentId: z.string(),
  oldState: CopilotTurnStateSchema,
  newState: CopilotTurnStateSchema,
  timestamp: z.number(),
});

export type TurnStateChanged = z.infer<typeof TurnStateChangedSchema>;
