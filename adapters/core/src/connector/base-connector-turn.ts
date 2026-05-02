import type { ScopedBus } from '@makaio/bus-core';
import type { MessageHandle } from '../message-handle/message-handle.js';

/**
 * Result of pausing a turn.
 * @typeParam TState - Turn state type
 */
export interface PauseResult<TState = string> {
  /** The state the turn was in before pausing */
  stateBeforePause: TState;
  /** Whether the turn had already ended when pause was requested */
  turnEnded: boolean;
}

/**
 * Base abstract class for connector turn implementations.
 *
 * Turns manage the state machine for a single user message:
 * - State transitions (idle to turn_started to step_started to ...)
 * - Pause/resume mechanics
 * - Safe boundary detection for immediate messages
 * - Message handle delegation (acknowledgment, completion)
 *
 * Each adapter implements its own turn subclass with adapter-specific
 * state handling and SDK integration.
 * @typeParam TState - Turn state enum type (string union)
 */
export abstract class BaseConnectorTurn<TState extends string = string> {
  protected state: TState;
  protected readonly bus: ScopedBus<string>;
  protected readonly adapterId: string;
  protected readonly adapterName: string;
  protected stateChangedCallback?: (oldState: TState, newState: TState) => Promise<void> | void;

  /**
   * Active message handle for this turn.
   * Subclasses must provide this handle for message lifecycle management.
   */
  protected abstract activeMessageHandle: MessageHandle;

  public constructor(bus: ScopedBus<string>, adapterId: string, adapterName: string, initialState: TState) {
    this.bus = bus;
    this.adapterId = adapterId;
    this.adapterName = adapterName;
    this.state = initialState;
  }

  /**
   * Pause the turn at next safe boundary.
   * @returns Pause result indicating whether turn already ended
   */
  public abstract pause(): Promise<PauseResult<TState>>;

  /**
   * Resume the paused turn with optional additional message.
   * @param message - Optional message to inject when resuming
   */
  public abstract resume(message?: unknown): Promise<void>;

  /**
   * Check if turn is currently paused.
   */
  public abstract isPaused(): boolean;

  /**
   * Register callback for state changes.
   * @param cb - Callback to invoke on state transitions
   */
  public onStateChanged(cb: (oldState: TState, newState: TState) => Promise<void> | void): void {
    this.stateChangedCallback = cb;
  }

  /**
   * Transition to new state and notify listeners.
   * Template method for shared state transition pattern.
   *
   * NOTE: Subclasses should use their typed namespace subjects for emission.
   * This is a template - concrete implementation in adapter-specific Turn classes.
   * @param newState - New state to transition to
   */
  protected async transitionTo(newState: TState): Promise<void> {
    const oldState = this.state;
    this.state = newState;

    // Subclasses emit via typed subjects (see ClaudeConnectorTurn for example)
    await this.emitStateChange(oldState, newState);

    // Invoke registered callback if exists
    await this.stateChangedCallback?.(oldState, newState);
  }

  /**
   * Emit state change event - implemented by subclass with typed subjects.
   * @param oldState - Previous state
   * @param newState - New state
   */
  protected abstract emitStateChange(oldState: TState, newState: TState): Promise<void>;

  /**
   * Get current turn state.
   * @returns Current turn state
   */
  public getState(): TState {
    return this.state;
  }

  /**
   * Get the message handle for this turn.
   * @returns The message handle for this turn
   */
  public getMessageHandle(): MessageHandle {
    return this.activeMessageHandle;
  }

  /**
   * Mark message handle as acknowledged.
   */
  public markAcknowledged(): void {
    this.activeMessageHandle.markAcknowledged();
  }

  /**
   * Mark message handle as completed.
   * @param result - The completion result with outcome and optional result/error
   */
  public markCompleted(result: { outcome: string; result?: unknown; error?: unknown }): void {
    this.activeMessageHandle.markCompleted(result as Parameters<MessageHandle['markCompleted']>[0]);
  }
}
