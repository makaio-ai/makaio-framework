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
 * ## Turn pairing contract
 *
 * `agent.turn.started` and `agent.turn.completed` are emitted **only as a
 * matched pair** for handles that actually start a provider turn (i.e. whose
 * acknowledgment is delivered). Handles completed before dispatch — merged,
 * superseded, or rejected while queued — never receive `turn.started` and
 * therefore never receive `turn.completed`. The message-level event
 * `user_message.completed` always fires regardless of delivery, carrying the
 * terminal outcome so downstream consumers (storage, UI cleanup) can react
 * to every message disposition.
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
 *    active, it is appended to `pendingTrackedHandles` (a FIFO queue). It does
 *    NOT become the correlation source until all handles ahead of it in the
 *    queue have been promoted or removed.
 * 3. When the active handle completes, the head of the pending queue (if any)
 *    is promoted to active — making its correlation visible for usage emitted
 *    by its turn. This preserves FIFO ordering with the connector's
 *    `UserMessageQueue`.
 * 4. A pending handle that completes before promotion (e.g. cancelled or
 *    superseded while queued) is removed from wherever it sits in the queue,
 *    without disrupting the order of remaining pending handles.
 * 5. For the first handle dispatched (no prior active), the handle is set
 *    eagerly so that usage arriving before the provider acknowledges the
 *    message is still correlated (closes the early-close / result-only stream
 *    window from the previous fix).
 * 6. A handle that is already processed (`isProcessed === true`) at `track()`
 *    time — e.g. completed by shutdown gates before the agent's
 *    `onMessageHandle` callback ran — **never becomes the correlation source**.
 *    It is neither promoted to active nor queued as pending. Completion
 *    transforms are skipped (the pipeline already ran), but the completion
 *    subscription still fires and `onTerminal` is still called, preserving
 *    the terminal lifecycle contract for the caller.
 */
export class MessageLifecycleTracker {
  /** Handle of the currently executing turn — the active correlation source. */
  private currentMessageHandle?: MessageHandle;

  /**
   * FIFO queue of handles tracked while another turn was still in-flight.
   * The head of the queue is promoted to `currentMessageHandle` when the
   * active handle completes. Handles that complete while queued (e.g.
   * cancelled or superseded) are removed from wherever they sit without
   * disrupting the order of remaining entries.
   */
  private readonly pendingTrackedHandles: MessageHandle[] = [];

  /**
   * Set of handles for which `acknowledge()` emitted `agent.turn.started`.
   * Used by `complete()` to decide whether to emit `agent.turn.completed` —
   * only handles in this set receive the completion counterpart, preserving
   * the turn pairing contract. The handle is removed from the set when
   * `complete()` fires.
   */
  private readonly turnStartedHandles = new Set<MessageHandle>();

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
   * This should only be called for handles whose acknowledgment was
   * genuinely delivered (i.e. `waitForAcknowledgment()` resolved with
   * `true`). Handles completed before dispatch (merged, superseded, or
   * rejected) resolve acknowledgment with `false` — calling acknowledge()
   * for those would steal the active correlation slot from the real
   * in-flight turn.
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
    // track(), remove it from the queue since it is now active.
    this.currentMessageHandle = handle;
    this.removePendingHandle(handle);

    // Emit user_message.acknowledged
    void this.emitGlobal(AgentSubjects.user_message.acknowledged, {
      messageId,
      mergedFrom,
      ...(turnId !== undefined && { turnId }),
    });

    // Emit agent.turn.started (higher-level abstraction).
    // Record the handle so complete() knows to emit the paired turn.completed.
    this.turnStartedHandles.add(handle);
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
   * - agent.turn.completed — **only** when `acknowledge()` emitted
   *   `agent.turn.started` for this handle (turn pairing contract)
   * - user_message.completed — always, with outcome details
   * @param handle - The message handle being completed
   * @param result - The completion result with outcome
   * @param turnId - Turn ID captured when the handle was registered
   */
  public complete(handle: MessageHandle, result: MessageResult, turnId?: string): void {
    const { messageId } = handle;

    // Clear lifecycle state only if this handle is still active (it might have been superseded).
    // When pending handles exist, promote the queue head to active so its correlation becomes
    // visible for the turn that is about to execute. This preserves FIFO ordering with the
    // connector's UserMessageQueue.
    if (this.currentMessageHandle === handle) {
      this.currentMessageHandle = this.pendingTrackedHandles.shift();
    } else {
      // The handle completed before it was promoted (e.g. cancelled or superseded while
      // queued). Remove it from wherever it sits in the queue without disrupting order.
      this.removePendingHandle(handle);
    }
    if (this.currentTurnId === turnId) {
      this.currentTurnId = undefined;
    }

    // Emit agent.turn.completed only when the handle actually started a turn
    // (i.e. acknowledge() emitted agent.turn.started for it). Handles completed
    // before dispatch — merged, superseded, or rejected while queued — never
    // received turn.started, so emitting turn.completed would produce an
    // unpaired event that breaks lifecycle consumers counting active turns.
    if (this.turnStartedHandles.delete(handle)) {
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
    }

    // Emit user_message.completed (always, with outcome details — message-level
    // lifecycle fires regardless of whether a provider turn started)
    void this.emitGlobal(AgentSubjects.user_message.completed, {
      messageId,
      outcome: result.outcome,
      supersededBy: result.supersededBy,
      mergedInto: result.mergedInto,
      ...(turnId !== undefined && { turnId }),
    });
  }

  /**
   * Remove a handle from the pending queue if present.
   * @param handle - The handle to remove
   */
  private removePendingHandle(handle: MessageHandle): void {
    const idx = this.pendingTrackedHandles.indexOf(handle);
    if (idx >= 0) {
      this.pendingTrackedHandles.splice(idx, 1);
    }
  }

  /**
   * Wire up a message handle for lifecycle tracking.
   *
   * Subscribes to the handle's acknowledgment and completion promises
   * and emits the appropriate events. When `transformTerminal` is provided,
   * it is registered on the handle so validation or other post-processing
   * amends the public completion result before lifecycle events fire.
   *
   * **Already-processed handles:** When a handle is already completed or
   * cancelled at `track()` time (e.g. shutdown gates completed it before
   * the agent's `onMessageHandle` callback ran), it is never promoted to
   * the active correlation source and never queued as pending. The
   * completion transform is skipped (the handle already ran its transform
   * pipeline), but the completion and terminal subscriptions still fire so
   * the caller receives the full lifecycle contract (events emitted,
   * `onTerminal` called).
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

    // Already-processed guard: when shutdown gates (e.g. rejectQueuedHandles)
    // complete the handle before the agent calls track(), the handle's
    // completion pipeline has already started. Promoting it as the active
    // correlation source would leave a stale completed handle in the slot, and
    // calling addCompletionTransform() would throw. Skip promotion/queueing
    // and the transform registration — the waitForCompletion subscription
    // below still fires (deferred is already resolved) and delivers the
    // terminal lifecycle contract the caller expects.
    if (!handle.isProcessed) {
      // Correlation source assignment: only the handle whose turn is actually
      // executing should be the active correlation source. When no handle is
      // active, set eagerly so usage arriving before acknowledgment still
      // correlates (closes the early-close / result-only stream window).
      // When another handle IS active, append to the pending queue — it will be
      // promoted in FIFO order when handles ahead of it complete. This prevents
      // a queued follow-up from stealing correlation from the still-running turn,
      // and preserves ordering when multiple messages are queued concurrently.
      if (this.currentMessageHandle === undefined) {
        this.currentMessageHandle = handle;
      } else {
        this.pendingTrackedHandles.push(handle);
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
    }

    handle.waitForAcknowledgment().then(
      (delivered) => {
        // `delivered` is false when a handle is completed before dispatch
        // (e.g. merged, superseded, or rejected while queued). In that case
        // no provider turn actually started, so promoting the handle would
        // steal the active correlation slot from the real in-flight turn and
        // cause its completion to clear/advance the slot prematurely.
        if (delivered) {
          this.acknowledge(handle, trackedTurnId);
        }
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
