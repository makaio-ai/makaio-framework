import type { ScopedBus } from '@makaio/bus-core';
import type { ScopedSubjectDefinition } from '@makaio/core';
import { BaseConnectorTurn, type PauseResult } from './base-connector-turn.js';
import type { MessageHandle } from '../message-handle/message-handle.js';

/**
 * Typed subject references for turn lifecycle events.
 *
 * Each adapter provides its namespace-specific subjects when constructing
 * a ProceduralConnectorTurn. The subjects must all accept the same
 * TurnStateChangedPayload shape.
 * @typeParam TSubject - The subject definition type for the adapter's bus
 */
export interface TurnSubjects<TSubject = ScopedSubjectDefinition> {
  state_changed: TSubject;
  turn_started: TSubject;
  step_started: TSubject;
  step_finished: TSubject;
  turn_finished: TSubject;
}

/**
 * Standard turn state type for procedural adapters.
 *
 * Procedural adapters (Gemini, OpenAI, Copilot) use abort+restart
 * rather than true pause/resume. Their state machine is:
 * idle to turn_started to step_started to step_finished to turn_finished
 */
export type ProceduralTurnState = 'idle' | 'turn_started' | 'step_started' | 'step_finished' | 'turn_finished';

/**
 * Configuration for ProceduralConnectorTurn.
 * @typeParam TBus - Scoped bus type for the adapter
 * @typeParam TSubject - Subject definition type
 */
export interface ProceduralTurnConfig<TBus extends ScopedBus<string>, TSubject> {
  bus: TBus;
  adapterId: string;
  adapterName: string;
  agentId: string;
  messageHandle: MessageHandle;
  turnSubjects: TurnSubjects<TSubject>;
}

/**
 * Base turn implementation for procedural adapters (Gemini, OpenAI, Copilot).
 *
 * These adapters share an abort+restart pattern rather than true pause/resume.
 * This class extracts the common state machine, lifecycle methods, and
 * message handle delegation that was duplicated across all three.
 *
 * Subclasses only need to add adapter-specific behavior:
 * - Gemini: AbortController for SDK cancellation
 * - OpenAI: AbortController for SDK cancellation
 * - Copilot: SDK event handling (handleSdkEvent)
 * @typeParam TState - Turn state type (defaults to ProceduralTurnState)
 * @typeParam TBus - Scoped bus type for the adapter
 * @typeParam TSubject - Subject definition type for emit calls
 */
export class ProceduralConnectorTurn<
  TState extends string = ProceduralTurnState,
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TSubject extends ScopedSubjectDefinition = ScopedSubjectDefinition,
> extends BaseConnectorTurn<TState> {
  protected activeMessageHandle!: MessageHandle;
  protected readonly connectorBus: TBus;
  protected readonly agentId: string;
  protected readonly turnSubjects: TurnSubjects<TSubject>;
  protected aborted = false;

  public constructor(config: ProceduralTurnConfig<TBus, TSubject>, initialState: TState) {
    super(config.bus, config.adapterId, config.adapterName, initialState);
    this.connectorBus = config.bus;
    this.agentId = config.agentId;
    this.activeMessageHandle = config.messageHandle;
    this.turnSubjects = config.turnSubjects;
  }

  /**
   * Emit state change using adapter-provided turn subjects.
   * @param oldState - Previous state before transition
   * @param newState - New state after transition
   */
  protected async emitStateChange(oldState: TState, newState: TState): Promise<void> {
    const payload = {
      adapterId: this.adapterId,
      agentId: this.agentId,
      oldState,
      newState,
      timestamp: Date.now(),
    };

    await this.connectorBus.emit(this.turnSubjects.state_changed, payload);

    switch (newState) {
      case 'turn_started':
        await this.connectorBus.emit(this.turnSubjects.turn_started, payload);
        break;
      case 'step_started':
        await this.connectorBus.emit(this.turnSubjects.step_started, payload);
        break;
      case 'step_finished':
        await this.connectorBus.emit(this.turnSubjects.step_finished, payload);
        break;
      case 'turn_finished':
        await this.connectorBus.emit(this.turnSubjects.turn_finished, payload);
        break;
    }
  }

  /**
   * Start the turn.
   */
  public async start(): Promise<void> {
    await this.transitionTo('turn_started' as TState);
  }

  /**
   * Transition to step_started (called when first content arrives).
   * Allows turn_started to step_started AND step_finished to step_started
   * (for tool recursion).
   */
  public async markStepStarted(): Promise<void> {
    if (this.state === 'turn_started' || this.state === 'step_finished') {
      await this.transitionTo('step_started' as TState);
    }
  }

  /**
   * Transition to step_finished (called after content block completes).
   */
  public async markStepFinished(): Promise<void> {
    if (this.state === 'step_started') {
      await this.transitionTo('step_finished' as TState);
    }
  }

  /**
   * Mark turn as finished.
   */
  public async markTurnFinished(): Promise<void> {
    await this.transitionTo('turn_finished' as TState);
  }

  /**
   * Pause (abort) at next opportunity.
   * Procedural adapters don't support true pause - caller creates a new turn
   * with merged content instead.
   * @returns Pause result indicating turn state
   */
  public async pause(): Promise<PauseResult<TState>> {
    if (this.state === ('turn_finished' as TState)) {
      return { stateBeforePause: this.state, turnEnded: true };
    }

    const stateBeforePause = this.state;
    this.aborted = true;

    return { stateBeforePause, turnEnded: false };
  }

  /**
   * Resume is not supported for procedural adapters - caller creates new turn.
   * @param _message - Unused
   * @throws Error always
   */
  public async resume(_message?: unknown): Promise<void> {
    throw new Error(`${this.adapterName} does not support resume - create new turn with merged content`);
  }

  /**
   * Check if turn was aborted.
   * @returns True if turn was aborted
   */
  public isPaused(): boolean {
    return this.aborted;
  }

  /**
   * Check if turn is completed.
   * @returns True if turn has finished
   */
  public isCompleted(): boolean {
    return this.state === ('turn_finished' as TState);
  }

  /**
   * Check if turn can accept immediate message.
   * True if turn is active (not finished, not aborted).
   * @returns True if turn can accept an immediate message
   */
  public canAcceptImmediate(): boolean {
    return this.state !== ('turn_finished' as TState) && !this.aborted;
  }
}
