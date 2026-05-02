/**
 * Codex App-Server Turn State Machine
 *
 * Manages turn lifecycle for the codex app-server protocol.
 * A turn is a single user input → agent response cycle within a thread.
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

import { BaseConnectorTurn, type PauseResult, type MessageHandle } from '@makaio/ai-adapters-core';
import { CodexAppServerSubjects } from './namespaces/index.js';
import type { CodexAppServerBus, CodexAppServerTurnState } from './namespaces/index.js';

/**
 * Item types from the app-server protocol.
 * `dynamicToolCall` is part of the experimental API (not yet in the generated `ThreadItem` union)
 * and represents a call to a Makaio registry tool declared in `dynamicTools` at `thread/start`.
 */
export type ItemType =
  | 'agentMessage'
  | 'commandExecution'
  | 'fileChange'
  | 'reasoning'
  | 'mcpToolCall'
  | 'dynamicToolCall';

/**
 * Turn configuration for CodexAppServerTurn.
 */
export interface CodexAppServerTurnConfig {
  bus: CodexAppServerBus;
  adapterId: string;
  adapterName: string;
  agentId: string;
  threadId: string;
  messageHandle: MessageHandle;
}

/**
 * Turn state machine for Codex App-Server.
 *
 * Tracks state transitions based on app-server notifications:
 * - turn/started → processing_started state
 * - item/started → step_started state
 * - item/completed → step_finished state
 * - turn/completed → turn_finished state
 *
 * Similar to codex-mcp but adapted for app-server protocol:
 * - Uses turnId instead of taskId
 * - Item-based events instead of MCP event types
 * - Supports interrupt via turn/interrupt method
 */
export class CodexAppServerTurn extends BaseConnectorTurn<CodexAppServerTurnState> {
  private readonly connectorBus: CodexAppServerBus;
  private readonly agentId: string;
  private readonly threadId: string;
  protected activeMessageHandle!: MessageHandle;
  private turnId?: string;
  private currentItemId?: string;
  private currentItemType?: ItemType;
  private interrupted = false;

  public constructor(
    bus: CodexAppServerBus,
    adapterId: string,
    adapterName: string,
    agentId: string,
    threadId: string,
    messageHandle: MessageHandle,
  ) {
    super(bus, adapterId, adapterName, 'idle');
    this.connectorBus = bus;
    this.agentId = agentId;
    this.threadId = threadId;
    this.activeMessageHandle = messageHandle;
  }

  /**
   * Get the turn ID.
   * @returns Turn ID or undefined if not yet received from turn/started
   */
  public getTurnId(): string | undefined {
    return this.turnId;
  }

  /**
   * Set the turn ID from turn/started notification.
   * @param turnId - Turn ID from the app-server
   */
  public setTurnId(turnId: string): void {
    this.turnId = turnId;
  }

  /**
   * Get the current item ID being processed.
   * @returns Current item ID or undefined
   */
  public getCurrentItemId(): string | undefined {
    return this.currentItemId;
  }

  /**
   * Emit state change using typed namespace subjects.
   * @param oldState - The previous turn state
   * @param newState - The new turn state
   */
  protected async emitStateChange(oldState: CodexAppServerTurnState, newState: CodexAppServerTurnState): Promise<void> {
    const payload = {
      adapterId: this.adapterId,
      agentId: this.agentId,
      oldState,
      newState,
      timestamp: Date.now(),
    };

    await this.connectorBus.emit(CodexAppServerSubjects.turn_state_changed, payload);

    switch (newState) {
      case 'turn_started':
        await this.connectorBus.emit(CodexAppServerSubjects.turn_started, {
          agentId: this.agentId,
          threadId: this.threadId,
          turnId: this.turnId ?? '',
          timestamp: Date.now(),
        });
        break;
      case 'step_started':
        await this.connectorBus.emit(CodexAppServerSubjects.turn_step_started, {
          agentId: this.agentId,
          threadId: this.threadId,
          turnId: this.turnId ?? '',
          itemId: this.currentItemId ?? '',
          timestamp: Date.now(),
        });
        break;
      case 'step_finished':
        await this.connectorBus.emit(CodexAppServerSubjects.turn_step_finished, {
          agentId: this.agentId,
          threadId: this.threadId,
          turnId: this.turnId ?? '',
          itemId: this.currentItemId ?? '',
          timestamp: Date.now(),
        });
        break;
      case 'turn_finished':
        await this.connectorBus.emit(CodexAppServerSubjects.turn_completed, {
          agentId: this.agentId,
          threadId: this.threadId,
          turnId: this.turnId ?? '',
          timestamp: Date.now(),
        });
        break;
    }
  }

  /**
   * Start the turn - transition to active state.
   * Called when turn/start request is sent.
   */
  public async start(): Promise<void> {
    await this.transitionTo('active');
  }

  /**
   * Handle turn/started notification.
   * Transitions from active to processing_started.
   * @param turnId - Turn ID from the notification
   */
  public async handleTurnStarted(turnId: string): Promise<void> {
    this.turnId = turnId;
    await this.transitionTo('processing_started');
  }

  /**
   * Handle item/started notification.
   * Transitions from processing_started to turn_started (first item)
   * or from step_finished to step_started (subsequent items).
   * @param itemId - Item ID from the notification
   * @param itemType - Type of item (agentMessage, commandExecution, etc.)
   */
  public async handleItemStarted(itemId: string, itemType: ItemType): Promise<void> {
    this.currentItemId = itemId;
    this.currentItemType = itemType;

    if (this.state === 'processing_started') {
      // First item - transition to turn_started
      await this.transitionTo('turn_started');
      // Then immediately to step_started
      await this.transitionTo('step_started');
    } else if (this.state === 'step_finished') {
      // Next item in sequence
      await this.transitionTo('step_started');
    }
  }

  /**
   * Handle item/completed notification.
   * Transitions from step_started to step_finished.
   * @param itemId - Item ID from the notification
   */
  public async handleItemCompleted(itemId: string): Promise<void> {
    if (this.currentItemId !== itemId) {
      // Mismatch - ignore or log warning
      return;
    }

    if (this.state === 'step_started') {
      await this.transitionTo('step_finished');
    }
  }

  /**
   * Handle turn/completed notification.
   * Transitions from step_finished to turn_finished.
   */
  public async handleTurnCompleted(): Promise<void> {
    if (this.state === 'step_finished' || this.state === 'turn_started') {
      await this.transitionTo('turn_finished');
    }
  }

  /**
   * Mark turn as finished.
   * Called by connector when turn completes.
   */
  public async markTurnFinished(): Promise<void> {
    await this.transitionTo('turn_finished');
  }

  /**
   * Interrupt (pause) the turn.
   * Used for immediate mode - sends turn/interrupt and restarts with merged content.
   * @returns Pause result indicating whether turn had already ended
   */
  public async pause(): Promise<PauseResult<CodexAppServerTurnState>> {
    if (this.state === 'turn_finished') {
      return { stateBeforePause: this.state, turnEnded: true };
    }

    const stateBeforePause = this.state;
    this.interrupted = true;

    return { stateBeforePause, turnEnded: false };
  }

  /**
   * Resume is a no-op for app-server - caller creates new turn instead.
   * App-server doesn't support true resume - use interrupt + restart with merged content.
   * @param _message - Optional message (unused - app-server doesn't support resume)
   * @throws Error always - app-server requires creating a new turn with merged content
   */
  public async resume(_message?: unknown): Promise<void> {
    throw new Error('Codex app-server does not support resume - create new turn with merged content');
  }

  /**
   * Check if turn was interrupted.
   * @returns True if turn was interrupted
   */
  public isPaused(): boolean {
    return this.interrupted;
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
   * True if turn is active (not finished, not interrupted).
   * @returns True if turn can accept an immediate message
   */
  public canAcceptImmediate(): boolean {
    return this.state !== 'turn_finished' && !this.interrupted;
  }
}
