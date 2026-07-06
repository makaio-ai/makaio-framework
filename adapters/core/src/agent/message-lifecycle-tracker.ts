import type { MessageHandle, MessageResult } from '../message-handle/index.js';
import type { SubjectDefinition, ExtractSubjectPayload } from '@makaio/core';
import { AgentSubjects, type StructuredOutputValidation } from '@makaio/contracts';
import type { AgentContext } from './types.js';

/**
 * Emit function type for global bus emissions.
 * Matches the signature of AIAgent.emitGlobal.
 */
type EmitGlobalFn = <S extends SubjectDefinition>(
  subject: S,
  payload: Omit<ExtractSubjectPayload<S>, keyof AgentContext> & { turnId?: string },
) => Promise<void>;

/**
 * Configuration for MessageLifecycleTracker.
 */
export interface MessageLifecycleTrackerConfig {
  /** Function to emit events to global bus with auto-enrichment */
  emitGlobal: EmitGlobalFn;
}

/** Options for tracking a connector message handle. */
export interface MessageLifecycleTrackOptions {
  /** Turn ID captured before connector dispatch, if the request belongs to a session turn. */
  turnId: string | undefined;
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
   * @param turnId - Turn ID captured when the handle was registered
   */
  public acknowledge(handle: MessageHandle, turnId?: string): void {
    const { messageId, message, mergedFrom } = handle;

    this.currentMessageId = messageId;

    // Emit user_message.acknowledged
    void this.emitGlobal(AgentSubjects.user_message.acknowledged, {
      messageId,
      mergedFrom,
      ...(turnId !== undefined && { turnId }),
    });

    // Emit agent.turn.started (higher-level abstraction)
    void this.emitGlobal(AgentSubjects.turn.started, {
      messageId,
      content: message,
      mergedFrom,
      ...(turnId !== undefined && { turnId }),
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
   * @param turnId - Turn ID captured when the handle was registered
   */
  public complete(handle: MessageHandle, result: MessageResult, turnId?: string): void {
    const { messageId } = handle;

    // Clear currentMessageId only if still current (might have been superseded)
    if (this.currentMessageId === messageId) {
      this.currentMessageId = undefined;
    }
    if (this.currentTurnId === turnId) {
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
      ...(result.structuredOutputValidation !== undefined
        ? { structuredOutputValidation: result.structuredOutputValidation }
        : {}),
      ...(turnId !== undefined && { turnId }),
    });

    // Emit user_message.completed (always, with outcome details)
    void this.emitGlobal(AgentSubjects.user_message.completed, {
      messageId,
      outcome: result.outcome,
      supersededBy: result.supersededBy,
      mergedInto: result.mergedInto,
      ...(turnId !== undefined && { turnId }),
    });
  }

  /**
   * Wire up a message handle for lifecycle tracking.
   *
   * Subscribes to the handle's acknowledgment and completion promises
   * and emits the appropriate events. When `transformTerminal` is provided,
   * it is registered on the handle so validation or other post-processing
   * amends the public completion result before lifecycle events fire.
   * @param handle - The message handle to track
   * @param onTerminal - Optional callback for any terminal outcome (emits agent.complete)
   * @param transformTerminal - Optional async transform applied before public completion resolves
   * @param options - Optional tracking metadata captured before connector dispatch
   */
  public track(
    handle: MessageHandle,
    onTerminal?: (messageId: string, result: MessageResult, turnId: string | undefined) => void,
    transformTerminal?: (result: MessageResult) => Promise<MessageResult>,
    options?: MessageLifecycleTrackOptions,
  ): void {
    const trackedTurnId = options ? options.turnId : this.currentTurnId;

    if (transformTerminal !== undefined) {
      handle.addCompletionTransform(async (result) => {
        try {
          return await transformTerminal(result);
        } catch (error) {
          // Transform failed — synthesize a validation failure so the cause is
          // visible in every completion consumer while preserving the terminal
          // event invariant: complete() and onTerminal must always be called.
          const structuredOutputValidation: StructuredOutputValidation = {
            status: 'failed',
            errors: [
              {
                message: error instanceof Error ? error.message : 'Structured output validation failed',
                instancePath: '',
                schemaPath: '#',
              },
            ],
          };
          return { ...result, structuredOutputValidation };
        }
      });
    }

    handle.waitForAcknowledgment().then(() => {
      this.acknowledge(handle, trackedTurnId);
    });

    handle.waitForCompletion().then((finalResult) => {
      this.complete(handle, finalResult, trackedTurnId);

      if (onTerminal) {
        onTerminal(handle.messageId, finalResult, trackedTurnId);
      }
    });
  }
}
