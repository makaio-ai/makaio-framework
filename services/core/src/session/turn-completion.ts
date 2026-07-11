import type { Turn } from './entities/turn.js';

/** Result of a completed turn. */
export interface TurnCompletionResult {
  /** Whether all agents completed successfully. */
  success: boolean;
  /** Error messages from agents that failed. */
  errors: string[];
}

/**
 * Callback invoked when every agent participating in a turn has finished.
 * @param turn - Completed turn.
 * @param result - Canonical success and error result.
 */
export type TurnCompleteCallback = (turn: Turn, result: TurnCompletionResult) => Promise<void>;
