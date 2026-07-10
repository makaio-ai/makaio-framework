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
 *
 * ## Correlation source contract
 *
 * The "active" handle (`currentMessageHandle`) is the correlation source for
 * usage events emitted by the provider. The invariant:
 *
 * 1. A handle becomes the active correlation source **only when no other
 *    tracked handle is still in-flight**. This ensures usage from the executing
 *    turn is attributed to the correct request.
 * 2. When a handle is tracked via `track()` while another handle is already
 *    active, it is stored as `pendingTrackedHandle`. It does NOT become the
 *    correlation source until the in-flight handle completes.
 * 3. When the active handle completes, the pending handle (if any) is promoted
 *    to active — making its correlation visible for usage emitted by its turn.
 * 4. For the first handle dispatched (no prior active), the handle is set
 *    eagerly so that usage arriving before the provider acknowledges the
 *    message is still correlated (closes the early-close / result-only stream
 *    window from the previous fix).
 */
export class MessageLifecycleTracker {
  /** Handle of the currently executing turn — the active correlation source. */
  private currentMessageHandle?: MessageHandle;

  /**
   * Handle tracked while another turn was still in-flight.
   * Promoted to `currentMessageHandle` when the active handle completes.
   */
  private pendingTrackedHandle?: MessageHandle;

  /** Current turnId from the session orchestrator (set at sendMessage entry, cleared on completion) */
  private currentTurnId?: string;

  /** Emit function injected from AIAgent */
  private readonly emitGlobal: EmitGlobalFn;

  public constructor(config: MessageLifecycleTrackerConfig) {
    this.emitGlobal = config.emitGlobal;
  }

  /**
   * Get the current messageId being processed.
   * Derived from the active message handle to avoid dual state.
   * Used by enrichPayload() to add messageId to intermediate events.
   * @returns The current messageId or undefined if no message is being processed
   */
  public getCurrentMessageId(): string | undefined {
    return this.currentMessageHandle?.messageId;
  }

  /**
   * Get the active message handle being processed.
   * @returns The active message handle or undefined if no message is being processed
   */
  public getCurrentMessageHandle(): MessageHandle | undefined {
    return this.currentMessageHandle;
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

    // Acknowledgment is the authoritative signal that the provider is actively
    // processing this handle. Promote it to the active correlation source
    // unconditionally — by the time the provider acknowledges, the handle's
    // turn is genuinely executing. If the handle was stored as pending in
    // track(), clear that slot since it is now active.
    this.currentMessageHandle = handle;
    if (this.pendingTrackedHandle === handle) {
      this.pendingTrackedHandle = undefined;
    }

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

    // Clear lifecycle state only if this handle is still active (it might have been superseded).
    // When a pending handle exists, promote it to active so its correlation becomes visible
    // for the turn that is about to execute.
    if (this.currentMessageHandle === handle) {
      this.currentMessageHandle = this.pendingTrackedHandle;
      this.pendingTrackedHandle = undefined;
    } else if (this.pendingTrackedHandle === handle) {
      // The pending handle completed before it was promoted (e.g. cancelled while queued).
      this.pendingTrackedHandle = undefined;
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

    // Correlation source assignment: only the handle whose turn is actually
    // executing should be the active correlation source. When no handle is
    // active, set eagerly so usage arriving before acknowledgment still
    // correlates (closes the early-close / result-only stream window).
    // When another handle IS active, store as pending — it will be promoted
    // when the in-flight handle completes. This prevents a queued follow-up
    // from stealing correlation from the still-running turn.
    if (this.currentMessageHandle === undefined) {
      this.currentMessageHandle = handle;
    } else {
      this.pendingTrackedHandle = handle;
    }

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

    handle.waitForAcknowledgment().then(
      () => {
        this.acknowledge(handle, trackedTurnId);
      },
      () => {
        // Acknowledgment rejects when the handle is cancelled before dispatch.
        // No turn starts in that case; the completion subscription below still
        // fires (cancel() resolves completion) and clears the tracked slots.
      },
    );

    handle.waitForCompletion().then((finalResult) => {
      this.complete(handle, finalResult, trackedTurnId);

      if (onTerminal) {
        onTerminal(handle.messageId, finalResult, trackedTurnId);
      }
    });
  }
}
