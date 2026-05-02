import type { MessageHandle, MessageResult } from '../message-handle/index.js';
import type { SubjectDefinition, ExtractSubjectPayload } from '@makaio/core';
import { AgentSubjects } from '@makaio/contracts';
import type { AgentContext } from './types.js';

/**
 * Emit function type for global bus emissions.
 * Matches the signature of AIAgent.emitGlobal.
 */
type EmitGlobalFn = <S extends SubjectDefinition>(
  subject: S,
  payload: Omit<ExtractSubjectPayload<S>, keyof AgentContext>,
) => Promise<void>;

/**
 * Configuration for MessageLifecycleTracker.
 */
export interface MessageLifecycleTrackerConfig {
  /** Function to emit events to global bus with auto-enrichment */
  emitGlobal: EmitGlobalFn;
}

/**
 * Tracks message lifecycle and emits corresponding events.
 *
 * Responsibilities:
 * - Track current messageId being processed
 * - Emit user_message.acknowledged / user_message.completed events
 * - Emit agent.turn.started / agent.turn.completed events
 *
 * This provides a clean separation between message lifecycle tracking
 * and the core AIAgent functionality.
 */
export class MessageLifecycleTracker {
  /** Current messageId being processed (set on acknowledgment, cleared on completion) */
  private currentMessageId?: string;

  /** Current turnId from the session orchestrator (set at sendMessage entry, cleared on completion) */
  private currentTurnId?: string;

  /** Emit function injected from AIAgent */
  private readonly emitGlobal: EmitGlobalFn;

  public constructor(config: MessageLifecycleTrackerConfig) {
    this.emitGlobal = config.emitGlobal;
  }

  /**
   * Get the current messageId being processed.
   * Used by enrichPayload() to add messageId to intermediate events.
   * @returns The current messageId or undefined if no message is being processed
   */
  public getCurrentMessageId(): string | undefined {
    return this.currentMessageId;
  }

  /**
   * Set the current turnId from the session orchestrator.
   * Called at the start of sendMessage processing.
   * @param turnId - Turn ID to track, or undefined to clear
   */
  public setCurrentTurnId(turnId: string | undefined): void {
    this.currentTurnId = turnId;
  }

  /**
   * Clear the currently tracked turn ID.
   */
  public clearCurrentTurnId(): void {
    this.currentTurnId = undefined;
  }

  /**
   * Get the current turnId being processed.
   * Used by enrichPayload() to add turnId to intermediate events.
   * @returns The current turnId or undefined if not set
   */
  public getCurrentTurnId(): string | undefined {
    return this.currentTurnId;
  }

  /**
   * Acknowledge a message - marks turn start.
   *
   * Emits:
   * - user_message.acknowledged
   * - agent.turn.started
   * @param handle - The message handle being acknowledged
   */
  public acknowledge(handle: MessageHandle): void {
    const { messageId, message, mergedFrom } = handle;

    this.currentMessageId = messageId;

    // Emit user_message.acknowledged
    void this.emitGlobal(AgentSubjects.user_message.acknowledged, {
      messageId,
      mergedFrom,
    });

    // Emit agent.turn.started (higher-level abstraction)
    void this.emitGlobal(AgentSubjects.turn.started, {
      messageId,
      content: message,
      mergedFrom,
    });
  }

  /**
   * Complete a message - marks turn end.
   *
   * Emits:
   * - agent.turn.completed (always, with outcome — paired with agent.turn.started)
   * - user_message.completed (always, with outcome)
   * @param handle - The message handle being completed
   * @param result - The completion result with outcome
   */
  public complete(handle: MessageHandle, result: MessageResult): void {
    const { messageId } = handle;

    // Clear currentMessageId only if still current (might have been superseded)
    if (this.currentMessageId === messageId) {
      this.currentMessageId = undefined;
      this.currentTurnId = undefined;
    }

    // Emit agent.turn.completed for all outcomes (invariant: always paired with turn.started)
    void this.emitGlobal(AgentSubjects.turn.completed, {
      messageId,
      message: result.result?.message,
      outcome: result.outcome,
      error:
        result.error instanceof Error
          ? result.error.message
          : typeof result.error === 'string'
            ? result.error
            : undefined,
    });

    // Emit user_message.completed (always, with outcome details)
    void this.emitGlobal(AgentSubjects.user_message.completed, {
      messageId,
      outcome: result.outcome,
      supersededBy: result.supersededBy,
      mergedInto: result.mergedInto,
    });
  }

  /**
   * Wire up a message handle for lifecycle tracking.
   *
   * Subscribes to the handle's acknowledgment and completion promises
   * and emits the appropriate events.
   * @param handle - The message handle to track
   * @param onTerminal - Optional callback for any terminal outcome (emits agent.complete)
   */
  public track(handle: MessageHandle, onTerminal?: (messageId: string, result: MessageResult) => void): void {
    handle.waitForAcknowledgment().then(() => {
      this.acknowledge(handle);
    });

    handle.waitForCompletion().then((result) => {
      this.complete(handle, result);

      if (onTerminal) {
        onTerminal(handle.messageId, result);
      }
    });
  }
}
