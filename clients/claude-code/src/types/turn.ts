/**
 * Possible states for a Claude connector turn.
 */
export type ClaudeTurnState = 'idle' | 'turn_started' | 'step_started' | 'step_finished' | 'turn_finished' | 'paused';

/**
 * Minimal interface for an interruptable query transport.
 *
 * The Claude SDK's `Query` object is the only concrete implementation,
 * but this interface isolates the turn from the SDK dependency.
 * Only `interrupt()` is called by the turn (used in `pause()`).
 */
export interface IQueryInterruptable {
  /**
   * Interrupt the running query, causing the SDK to emit an error result.
   * @returns Promise resolving when the interrupt signal has been sent
   */
  interrupt(): Promise<void>;
}
