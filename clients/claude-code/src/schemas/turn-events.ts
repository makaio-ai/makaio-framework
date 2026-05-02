import { z } from 'zod';

/**
 * Possible states for a Claude connector turn.
 */
export const TurnStateSchema = z.enum([
  'idle',
  'turn_started',
  'step_started',
  'step_finished',
  'turn_finished',
  'paused',
]);

export type TurnState = z.infer<typeof TurnStateSchema>;

/**
 * Event emitted when turn state changes.
 * Used for typed bus emissions via ClaudeCodeConnectorSubjects.turn.*
 */
export const TurnStateChangedEventSchema = z.object({
  adapterId: z.string(),
  agentId: z.string(),
  oldState: TurnStateSchema,
  newState: TurnStateSchema,
  timestamp: z.number(),
});

export type TurnStateChangedEvent = z.infer<typeof TurnStateChangedEventSchema>;
