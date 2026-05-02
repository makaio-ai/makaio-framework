import { z } from 'zod';

/**
 * Public turn-state contract for stream-session adapters.
 *
 * Both Anthropic SDK and OpenAI Node adapters share these states.
 * Neither uses a 'paused' state — they abort and restart instead.
 */
export type StreamSessionTurnState = 'idle' | 'turn_started' | 'step_started' | 'step_finished' | 'turn_finished';

/**
 * Public payload contract for turn-state transitions.
 */
export interface TurnStateChanged {
  /** The adapter instance identifier. */
  adapterId: string;
  /** The agent this turn belongs to. */
  agentId: string;
  /** The state being left. */
  oldState: StreamSessionTurnState;
  /** The state being entered. */
  newState: StreamSessionTurnState;
  /** Unix timestamp (ms) when the transition occurred. */
  timestamp: number;
}

/**
 * Shared turn state schema for stream-session adapters.
 */
export const StreamSessionTurnStateSchema = z.enum([
  'idle',
  'turn_started',
  'step_started',
  'step_finished',
  'turn_finished',
]) satisfies z.ZodType<StreamSessionTurnState>;

/**
 * Schema for a turn state change event.
 * Emitted by adapters whenever the turn state machine transitions.
 * @param adapterId - The adapter instance identifier.
 * @param agentId - The agent this turn belongs to.
 * @param oldState - The state being left.
 * @param newState - The state being entered.
 * @param timestamp - Unix timestamp (ms) when the transition occurred.
 */
export const TurnStateChangedSchema = z.object({
  adapterId: z.string(),
  agentId: z.string(),
  oldState: StreamSessionTurnStateSchema,
  newState: StreamSessionTurnStateSchema,
  timestamp: z.number(),
}) satisfies z.ZodType<TurnStateChanged>;
