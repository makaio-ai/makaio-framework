import { z } from 'zod';

/**
 * Turn state for Codex App-Server connector.
 *
 * State machine follows the app-server protocol:
 * - idle → active (turn/start request sent)
 * - active → processing_started (turn/started notification received)
 * - processing_started → turn_started (first item/started notification)
 * - turn_started → step_started (command/file item starts)
 * - step_started → step_finished (item completes)
 * - step_finished → turn_finished (turn/completed received)
 * - turn_finished → idle (cleanup, ready for next turn)
 *
 * Immediate mode: active → interrupted → idle (cancelled, new turn with merged content)
 */
export const CodexAppServerTurnStateSchema = z.enum([
  'idle',
  'active',
  'processing_started',
  'turn_started',
  'step_started',
  'step_finished',
  'turn_finished',
  'interrupted',
]);

export type CodexAppServerTurnState = z.infer<typeof CodexAppServerTurnStateSchema>;

/**
 * Turn state change event
 * Emitted whenever turn state transitions
 */
export const TurnStateChangedSchema = z.object({
  adapterId: z.string(),
  agentId: z.string(),
  oldState: CodexAppServerTurnStateSchema,
  newState: CodexAppServerTurnStateSchema,
  timestamp: z.number(),
});

/**
 * Schema for turn.started event
 * Emitted when a turn begins processing (turn_started state).
 *
 * Note: agentId is required for bus filtering to work correctly.
 */
export const TurnStartedSchema = z.object({
  agentId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
  timestamp: z.number(),
});

/**
 * Schema for turn.completed event
 * Emitted when a turn completes (turn_finished state).
 *
 * Note: agentId is required for bus filtering to work correctly.
 */
export const TurnCompletedSchema = z.object({
  agentId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
  timestamp: z.number(),
});

/**
 * Schema for turn.step_started event
 * Emitted when a step/item begins execution.
 *
 * Note: agentId is required for bus filtering to work correctly.
 */
export const TurnStepStartedSchema = z.object({
  agentId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  timestamp: z.number(),
});

/**
 * Schema for turn.step_finished event
 * Emitted when a step/item completes.
 *
 * Note: agentId is required for bus filtering to work correctly.
 */
export const TurnStepFinishedSchema = z.object({
  agentId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  timestamp: z.number(),
});

// Export inferred types
export type TurnStateChanged = z.infer<typeof TurnStateChangedSchema>;
export type TurnStarted = z.infer<typeof TurnStartedSchema>;
export type TurnCompleted = z.infer<typeof TurnCompletedSchema>;
export type TurnStepStarted = z.infer<typeof TurnStepStartedSchema>;
export type TurnStepFinished = z.infer<typeof TurnStepFinishedSchema>;
