import { BaseConnectorTurn, type PauseResult, MessageHandle } from '@makaio/ai-adapters-core';
import { DeferredPromise } from '@makaio/utils';
import type { ClaudeTurnState, IQueryInterruptable } from '@makaio/client-claude-code';
import type { ClaudeConnectorBus, ClaudeConnectorNamespace, SDKMessage } from '../namespace/index.js';

export type { ClaudeTurnState, IQueryInterruptable };

/**
 * Turn state machine for Claude SDK.
 *
 * Manages the lifecycle of a single user message turn:
 * - Tracks state transitions based on SDK events
 * - Provides pause/resume mechanics for immediate messages
 * - Emits typed events via the namespace subjects (turn.state_changed, turn.turn_started, etc.)
 *
 * State flow:
 * idle to turn_started to step_started to step_finished to turn_finished
 *                             ^               |
 *                             |               v
 *                             +--- paused ----+
 *
 * Transport seam: accepts `IQueryInterruptable` instead of the SDK's `Query` type
 * so the turn can be tested and reused without an SDK dependency.
 *
 * Namespace seam: accepts `subjects` from the caller so the turn works with any
 * Claude protocol namespace (adapter:claude-code, adapter:anthropic-sdk, etc.)
 * without being tied to a specific namespace registration.
 */
export class ClaudeConnectorTurn extends BaseConnectorTurn<ClaudeTurnState> {
  private readonly queryInstance: IQueryInterruptable;
  protected activeMessageHandle!: MessageHandle;
  private pausedDeferred?: DeferredPromise<void>;
  private isPausedFlag = false;
  private readonly connectorBus: ClaudeConnectorBus<string>;
  private readonly subjects: ClaudeConnectorNamespace<string>['subjects'];
  private readonly agentId: string;
  /** Flag to absorb interrupt error result without completing the turn */
  private expectingInterruptResult = false;

  /**
   * Create a turn state machine instance.
   * @param bus - Scoped connector bus used to emit turn lifecycle subjects
   * @param subjects - Namespace subjects for typed turn lifecycle emissions
   * @param adapterId - Persisted adapter instance identifier
   * @param adapterName - Stable adapter type name
   * @param agentId - Makaio agent identifier that owns this turn
   * @param queryInstance - Interruptable SDK query backing this turn
   * @param messageHandle - Active message handle tracked for this turn
   */
  public constructor(
    bus: ClaudeConnectorBus<string>,
    subjects: ClaudeConnectorNamespace<string>['subjects'],
    adapterId: string,
    adapterName: string,
    agentId: string,
    queryInstance: IQueryInterruptable,
    messageHandle: MessageHandle,
  ) {
    super(bus, adapterId, adapterName, 'idle');
    this.connectorBus = bus;
    this.subjects = subjects;
    this.agentId = agentId;
    this.queryInstance = queryInstance;
    this.activeMessageHandle = messageHandle;
  }

  /**
   * Replace the active message handle (used when immediate supersedes the original).
   * @param newHandle - New message handle to track
   */
  public setActiveMessageHandle(newHandle: MessageHandle): void {
    this.activeMessageHandle = newHandle;
  }

  /**
   * Emit state change using typed namespace subjects.
   * @param oldState - Previous state
   * @param newState - New state
   */
  protected async emitStateChange(oldState: ClaudeTurnState, newState: ClaudeTurnState): Promise<void> {
    const payload = {
      adapterId: this.adapterId,
      agentId: this.agentId,
      oldState,
      newState,
      timestamp: Date.now(),
    };

    // Emit generic state_changed event
    await this.connectorBus.emit(this.subjects.turn.state_changed, payload);

    // Emit specific state event for easier subscription
    switch (newState) {
      case 'turn_started':
        await this.connectorBus.emit(this.subjects.turn.turn_started, payload);
        break;
      case 'step_started':
        await this.connectorBus.emit(this.subjects.turn.step_started, payload);
        break;
      case 'step_finished':
        await this.connectorBus.emit(this.subjects.turn.step_finished, payload);
        break;
      case 'turn_finished':
        await this.connectorBus.emit(this.subjects.turn.turn_finished, payload);
        break;
      case 'paused':
        await this.connectorBus.emit(this.subjects.turn.paused, payload);
        break;
    }
  }

  /**
   * Start the turn - begins tracking SDK events.
   */
  public async start(): Promise<void> {
    await this.transitionTo('turn_started');
    // Actual SDK consumption happens in Session
  }

  /**
   * Pause at next safe boundary (step_finished).
   * Interrupts SDK query once boundary reached.
   * @returns Pause result indicating whether turn already ended
   */
  public async pause(): Promise<PauseResult<ClaudeTurnState>> {
    if (this.state === 'turn_finished') {
      return { stateBeforePause: this.state, turnEnded: true };
    }

    // Already paused
    if (this.isPausedFlag) {
      return { stateBeforePause: this.state, turnEnded: false };
    }

    // Wait for step_finished if not already there
    if (this.state !== 'step_finished') {
      await this.waitForStepFinished();
      if (this.getState() === 'turn_finished') {
        return { stateBeforePause: this.state, turnEnded: true };
      }
    }

    // Interrupt SDK query
    await this.queryInstance.interrupt();

    // Re-check after the async interrupt: the turn result may have arrived
    // during the await, transitioning state to turn_finished before we could set
    // expectingInterruptResult (TOCTOU window). If so, report turnEnded so the
    // caller does not proceed with a merge that would orphan the current handle.
    if (this.getState() === 'turn_finished') {
      return { stateBeforePause: this.state, turnEnded: true };
    }

    // SDK will emit an error result from the interrupt - we need to absorb it
    // so it doesn't incorrectly complete the turn
    this.expectingInterruptResult = true;

    this.isPausedFlag = true;
    const stateBeforePause = this.state;
    await this.transitionTo('paused');

    return { stateBeforePause, turnEnded: false };
  }

  /**
   * Resume the turn (called by Session after injecting new message).
   * @param _message - Optional message (unused - Session handles injection)
   */
  public async resume(_message?: unknown): Promise<void> {
    if (!this.isPausedFlag) {
      throw new Error('Cannot resume - turn not paused');
    }

    this.isPausedFlag = false;

    // Transition back to processing
    // Session handles actual message injection to source
    await this.transitionTo('step_started');
  }

  /**
   * Check if turn is currently paused.
   * @returns True if turn is paused
   */
  public isPaused(): boolean {
    return this.isPausedFlag;
  }

  /**
   * Handle SDK event and update turn state.
   * Called by Session's consumption loop.
   * @param msg - SDK message from consumption loop
   */
  public async handleSdkEvent(msg: SDKMessage): Promise<void> {
    if (msg.type === 'stream_event') {
      if (msg.event.type === 'content_block_start') {
        await this.transitionTo('step_started');
      } else if (msg.event.type === 'content_block_stop') {
        await this.transitionTo('step_finished');
        this.pausedDeferred?.resolve(); // Resolve if waiting for step_finished
      }
      // Note: message_delta with stop_reason='end_turn' does NOT trigger turn_finished
      // We wait for the 'result' message which contains the final result and usage stats
    } else if (msg.type === 'result') {
      // Check if this is an interrupt error result that we should absorb
      if (this.expectingInterruptResult) {
        this.expectingInterruptResult = false;
        // Absorbing interrupt error result — still processing the immediate message,
        // so we do not transition to turn_finished here.
        return;
      }
      // Only the result message triggers turn_finished
      // This ensures we have the result before notifying completion
      await this.transitionTo('turn_finished');
    }
  }

  /**
   * Check if turn is expecting an interrupt error result.
   * @returns True if expecting interrupt result
   */
  public isExpectingInterruptResult(): boolean {
    return this.expectingInterruptResult;
  }

  /**
   * Transition directly to turn_finished without a result message.
   *
   * Called by session when the subprocess exits with an error before
   * emitting a `result` message (e.g., process crash or spawn failure).
   * This ensures the connector state machine reaches `idle` instead of
   * hanging indefinitely.
   */
  public async finishOnError(): Promise<void> {
    // Unblock pending pause() waiters when completing the turn via error path.
    this.pausedDeferred?.resolve();
    this.pausedDeferred = undefined;
    this.isPausedFlag = false;
    this.expectingInterruptResult = false;

    if (this.state !== 'turn_finished') {
      await this.transitionTo('turn_finished');
    }
  }

  /**
   * Wait for turn to reach step_finished state.
   */
  private async waitForStepFinished(): Promise<void> {
    if (this.state === 'step_finished') return;

    this.pausedDeferred = new DeferredPromise<void>();
    try {
      await this.pausedDeferred.getPromise();
    } finally {
      this.pausedDeferred = undefined;
    }
  }

  /**
   * Check if turn is completed.
   * @returns True if turn has finished
   */
  public isCompleted(): boolean {
    return this.state === 'turn_finished';
  }

  /**
   * Check if turn can accept immediate message.
   * @returns True if turn is active and not paused
   */
  public canAcceptImmediate(): boolean {
    return this.state !== 'turn_finished' && !this.isPausedFlag;
  }
}
