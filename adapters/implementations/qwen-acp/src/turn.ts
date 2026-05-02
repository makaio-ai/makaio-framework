import { BaseConnectorTurn } from '@makaio/ai-adapters-core';
import type { PauseResult, MessageHandle } from '@makaio/ai-adapters-core';
import { QwenAcpSubjects } from './namespaces/index.js';
import type { QwenAcpBus } from './namespaces/index.js';

/**
 * Turn state machine for a single Qwen ACP request/response cycle.
 *
 * States progress linearly: idle → turn_started → step_started ↔ step_finished → turn_finished.
 * Steps represent individual generation phases (text output) and tool calls.
 */
export type QwenAcpTurnState = 'idle' | 'turn_started' | 'step_started' | 'step_finished' | 'turn_finished';

/**
 * Turn implementation for the Qwen ACP adapter.
 *
 * Owns one user prompt/response cycle. Emits lifecycle events on the
 * scoped bus and accumulates streamed text for the final result.
 *
 * Lifecycle: `start()` → optional `markStepStarted()` / `markStepFinished()` cycles
 * → `markTurnFinished()` (always in `finally`).
 */
export class QwenAcpTurn extends BaseConnectorTurn<QwenAcpTurnState> {
  /** Active message handle for this turn. */
  protected readonly activeMessageHandle: MessageHandle;

  /** Scoped bus typed for Qwen ACP subjects. */
  private readonly typedBus: QwenAcpBus;

  /** Agent instance identifier for lifecycle event payloads. */
  private readonly agentId: string;

  /** Accumulated streamed text from `agent_message_chunk` updates. */
  private accumulatedText = '';

  /** True when the turn has been interrupted for immediate-mode injection. */
  private interrupted = false;
  /** Step type associated with the current step lifecycle events. */
  private currentStepType: 'text' | 'tool_use' = 'text';

  /**
   * @param handle - Active message handle for this turn
   * @param bus - Qwen ACP scoped bus for event emission
   * @param adapterId - Adapter instance identifier
   * @param adapterName - Adapter type name
   * @param agentId - Agent instance identifier for event payloads
   */
  public constructor(handle: MessageHandle, bus: QwenAcpBus, adapterId: string, adapterName: string, agentId: string) {
    super(bus, adapterId, adapterName, 'idle');
    this.activeMessageHandle = handle;
    this.typedBus = bus;
    this.agentId = agentId;
  }

  // -- Text accumulation --

  /**
   * Get the full accumulated response text so far.
   * @returns Accumulated text from all `agent_message_chunk` deltas
   */
  public getAccumulatedText(): string {
    return this.accumulatedText;
  }

  /**
   * Append a streaming text delta to the accumulation buffer.
   * @param delta - Text delta received from `agent_message_chunk`
   */
  public appendText(delta: string): void {
    this.accumulatedText += delta;
  }

  // -- State transitions --

  /**
   * Begin the turn by transitioning from `idle` to `turn_started`.
   */
  public async start(): Promise<void> {
    await this.transitionTo('turn_started');
  }

  /**
   * Mark the beginning of a discrete step (text generation or tool call).
   * @param stepType - Semantic type for emitted step lifecycle events
   * Valid from `turn_started` or `step_finished`.
   */
  public async markStepStarted(stepType: 'text' | 'tool_use' = 'text'): Promise<void> {
    const state = this.getState();
    if (state === 'turn_started' || state === 'step_finished') {
      this.currentStepType = stepType;
      await this.transitionTo('step_started');
    }
  }

  /**
   * Mark a step as complete. Valid from `step_started` only.
   */
  public async markStepFinished(): Promise<void> {
    if (this.getState() === 'step_started') {
      await this.transitionTo('step_finished');
    }
  }

  /**
   * Finalize the turn.
   *
   * If the turn is currently in `step_started`, closes the open step first.
   * MUST be called in a `finally` block to guarantee state-machine cleanup.
   */
  public async markTurnFinished(): Promise<void> {
    if (this.getState() === 'step_started') {
      await this.transitionTo('step_finished');
    }
    if (this.getState() !== 'turn_finished' && this.getState() !== 'idle') {
      await this.transitionTo('turn_finished');
    }
  }

  /**
   * True when the turn has reached its terminal state.
   *
   * Required by the `QueueableTurn` interface consumed by `processQueueMessages`.
   * @returns True when the turn state is `turn_finished`
   */
  public isCompleted(): boolean {
    return this.getState() === 'turn_finished';
  }

  /**
   * True when the connector can inject an immediate message into this turn.
   * @returns False once the turn has finished or been interrupted
   */
  public canAcceptImmediate(): boolean {
    return this.getState() !== 'turn_finished' && !this.interrupted;
  }

  // -- Pause / resume (immediate-mode mechanics) --

  /**
   * Pause the turn at the next safe boundary.
   * @returns Pause result indicating whether the turn had already ended
   */
  public async pause(): Promise<PauseResult<QwenAcpTurnState>> {
    if (this.getState() === 'turn_finished') {
      return { stateBeforePause: this.getState(), turnEnded: true };
    }
    this.interrupted = true;
    return { stateBeforePause: this.getState(), turnEnded: false };
  }

  /**
   * Resume a paused turn.
   * @param _message - Unused; present to satisfy the base-class contract
   */
  public async resume(_message?: unknown): Promise<void> {
    this.interrupted = false;
  }

  /**
   * Check whether the turn is currently paused.
   * @returns True when the turn has been interrupted
   */
  public isPaused(): boolean {
    return this.interrupted;
  }

  // -- Bus emission --

  /**
   * Emit turn state-change and lifecycle events onto the Qwen ACP bus.
   *
   * Turn lifecycle events include `agentId` explicitly because this method calls
   * `bus.emit()` directly, bypassing `AIAgentConnector.emit()`.
   * @param oldState - State before the transition
   * @param newState - State after the transition
   */
  protected async emitStateChange(oldState: QwenAcpTurnState, newState: QwenAcpTurnState): Promise<void> {
    const timestamp = Date.now();
    const { agentId } = this;

    await this.typedBus.emit(QwenAcpSubjects.turn_state_changed, {
      agentId,
      previousState: oldState,
      newState,
      timestamp,
    });

    if (newState === 'turn_started') {
      await this.typedBus.emit(QwenAcpSubjects.turn_started, { agentId, timestamp });
    } else if (newState === 'step_started') {
      await this.typedBus.emit(QwenAcpSubjects.turn_step_started, {
        agentId,
        stepType: this.currentStepType,
        timestamp,
      });
    } else if (newState === 'step_finished') {
      await this.typedBus.emit(QwenAcpSubjects.turn_step_finished, {
        agentId,
        stepType: this.currentStepType,
        timestamp,
      });
    } else if (newState === 'turn_finished') {
      await this.typedBus.emit(QwenAcpSubjects.turn_finished, { agentId, timestamp });
    }
  }
}
