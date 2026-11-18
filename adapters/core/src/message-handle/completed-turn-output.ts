import type { MessageOutcome } from '@makaio/contracts';
import type { MessageResult } from './types.js';

/**
 * Terminal result of a turn that ended with any outcome other than `completed`.
 */
export type NonCompletedTurnResult = MessageResult & { outcome: Exclude<MessageOutcome, 'completed'> };

/**
 * Rejection raised when a turn's output is read but the turn ended with any
 * outcome other than `completed`.
 *
 * Carries the turn's terminal result so callers can tell a provider failure
 * from a cancellation and re-surface the outcome, and keeps the
 * connector-reported failure as `cause`.
 */
export class TurnNotCompletedError extends Error {
  /**
   * Create the rejection for a non-completed turn.
   * @param result - Terminal result of the turn; its `error`, if any, becomes `cause`
   */
  public constructor(public readonly result: NonCompletedTurnResult) {
    super(
      `Turn ended with outcome "${result.outcome}"${result.error === undefined ? '' : `: ${result.error instanceof Error ? result.error.message : result.error}`}`,
      result.error === undefined ? undefined : { cause: result.error },
    );
    this.name = 'TurnNotCompletedError';
  }

  /**
   * Terminal outcome of the turn.
   * @returns The non-completed outcome the turn ended with
   */
  public get outcome(): NonCompletedTurnResult['outcome'] {
    return this.result.outcome;
  }
}

/**
 * Read the output text of a terminal turn, failing closed.
 *
 * Only a `completed` turn produced output. Every other terminal outcome — an
 * asynchronous provider error, a failed completion transform, a cancellation —
 * throws, so a failure never reaches callers or schema validation as an empty
 * or partial answer.
 * @param result - Terminal result of the turn
 * @returns Final message text of the completed turn
 */
export function requireCompletedTurnText(result: MessageResult): string {
  if (result.outcome !== 'completed') {
    throw new TurnNotCompletedError({ ...result, outcome: result.outcome });
  }
  return result.result?.message ?? '';
}
