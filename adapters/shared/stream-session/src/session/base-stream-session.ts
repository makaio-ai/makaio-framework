import { OnceAbortError } from '@makaio/bus-core';
import type { ScopedBus } from '@makaio/bus-core';
import type { PayloadFilter, ScopedSubjectDefinition } from '@makaio/core';
import {
  BaseConnectorSession,
  UserMessageQueue,
  processQueueMessages,
  type MessageHandle,
  ProceduralConnectorTurn,
} from '@makaio/ai-adapters-core';
import type { StreamSessionConfig, StreamSdkEventEnvelope } from './types.js';
import type { MessageCompleteEvent } from '../namespaces/schemas/message.js';

const STREAM_START_TIMEOUT_ERROR = 'stream_start_timeout';

/**
 * Turn contract required by `BaseStreamSession`.
 *
 * Stream sessions depend on the core procedural turn lifecycle plus an abort
 * signal accessor used by `runTurnIteration`.
 */
export interface StreamSessionTurn extends ProceduralConnectorTurn {
  /**
   * Get the current abort signal for this turn.
   * @returns AbortSignal for stream cancellation
   */
  getAbortSignal(): AbortSignal;
}

/**
 * Abstract base class for stream-based AI connector sessions.
 *
 * Captures the shared session lifecycle logic between the Anthropic SDK and
 * OpenAI Node adapters. Both adapters use an identical queue-based turn model:
 *
 * 1. `processQueue` — dequeues messages and dispatches to `startNewTurn`
 * 2. `startNewTurn` — initialises a new turn, wires the finally-cleanup, and
 *    fires the async `queueMicrotask` loop
 * 3. `runTurn` → `runTurnIteration` — the agentic loop; executes streaming
 *    API calls and recurses when tool calls are returned
 * 4. `executeStreamingStep` — the stream-start-timeout wrapper; delegates the
 *    actual API call to the abstract `executeApiCall` hook
 * 5. `applyMessageComplete` — abstract; each adapter appends the assistant
 *    response in its own wire format and handles tool recursion
 *
 * ## Generic type parameters
 * @typeParam TConfig - Adapter session config extending `StreamSessionConfig`
 * @typeParam TTurn - Adapter turn type extending `ProceduralConnectorTurn`
 * @typeParam TMessageCompleteEvent - Adapter-specific `MessageCompleteEvent`
 *   extension; defaults to the shared base schema type
 */
export abstract class BaseStreamSession<
  TConfig extends StreamSessionConfig<ScopedBus<string>>,
  TTurn extends StreamSessionTurn,
  TMessageCompleteEvent extends MessageCompleteEvent = MessageCompleteEvent,
> extends BaseConnectorSession<TConfig> {
  /**
   * Maximum number of tool-call recursion steps per turn.
   * Subclasses reference this in `applyMessageComplete`.
   */
  protected static readonly MAX_TOOL_CALL_ITERATIONS = 8;

  /** Active turn reference; overwritten on each new turn. */
  declare protected currentTurn: TTurn | undefined;

  /** Assembled last assistant message content; reset on each new turn. */
  protected lastAssistantMessage: string | undefined;

  /** Runtime model used for subsequent API calls; set from config.model. */
  protected currentModel: string;

  /** Runtime working directory for tool execution; set from config.cwd. */
  protected currentCwd: string;

  /**
   * Initialize a stream session with connector runtime config.
   * @param config - Session configuration (bus identity, model/cwd defaults, and adapter hooks).
   */
  public constructor(config: TConfig) {
    super(config);
    // No server-side sessions in stream-based adapters — use a local UUID.
    this.sessionId = crypto.randomUUID();
    this.currentModel = config.model;
    this.currentCwd = config.cwd;
  }

  // ---------------------------------------------------------------------------
  // Abstract hooks — each adapter must implement these
  // ---------------------------------------------------------------------------

  /**
   * Create the adapter-specific turn instance for `handle`.
   * @param handle - The message handle this turn will process
   * @returns A new turn instance
   */
  protected abstract createTurn(handle: MessageHandle): TTurn;

  /**
   * Build (or rebuild) the adapter-specific messages array from the message
   * handle's history and optional merged content from superseded messages.
   * @param handle - The message handle containing history and current message
   * @param mergedContent - Text content from superseded/merged messages
   */
  protected abstract buildMessages(handle: MessageHandle, mergedContent?: string[]): void;

  /**
   * Execute the adapter-specific streaming API call.
   *
   * Called inside `executeStreamingStep` after the stream-start timeout is
   * armed. Implementors must operate on the provided turn instance rather than
   * reading `this.currentTurn` directly so superseded turns cannot mutate the
   * active turn state.
   * @param turn - Captured turn instance for this run loop
   * @param abortSignal - Combined abort signal (turn abort + stream timeout)
   * @param adapterSessionId - Turn-scoped adapter session ID for event correlation
   */
  protected abstract executeApiCall(turn: TTurn, abortSignal: AbortSignal, adapterSessionId: string): Promise<void>;

  /**
   * Return the bus subject to `once()` on for the `message_complete` event.
   *
   * Each adapter listens on its own namespace subject (e.g.
   * `AnthropicSdkConnectorSubjects.sdk.event`).
   * @returns The bus subject for the adapter's SDK event stream
   */
  protected abstract getSdkEventSubject(): ScopedSubjectDefinition<string>;

  /**
   * Apply a `message_complete` event to the messages array and recurse for
   * tool calls.
   *
   * Called in `runTurnIteration` after `message_complete` is received from
   * the bus. Implementations append the assistant message in the adapter's
   * wire format, check the tool-call finish reason, and call
   * `runTurnIteration` again when tools need executing.
   * @param result - The parsed `message_complete` event payload
   * @param currentHandle - The active message handle
   * @param toolCallIteration - Current recursion depth (for iteration guard)
   * @param turn - Captured turn instance for this run loop
   */
  protected abstract applyMessageComplete(
    result: TMessageCompleteEvent,
    currentHandle: MessageHandle,
    toolCallIteration: number,
    turn: TTurn,
  ): Promise<void>;

  /**
   * Classify an SDK-level error into the appropriate error type.
   *
   * The base class re-throws whatever this returns; adapters map SDK-specific
   * error shapes (e.g. Anthropic's `APIError`, OpenAI's `APIError`) to
   * normalised error instances.
   * @param error - The raw error caught from the API call or stream
   * @returns A normalised `Error` instance
   */
  protected abstract classifyError(error: unknown): Error;

  // ---------------------------------------------------------------------------
  // Concrete shared methods
  // ---------------------------------------------------------------------------

  /**
   * Process messages from the queue.
   *
   * Creates a new turn or handles immediate injection via abort+restart.
   * @param queue - The user message queue to drain
   */
  public async processQueue(queue: UserMessageQueue): Promise<void> {
    await processQueueMessages(queue, {
      getCurrentTurn: () => this.currentTurn,
      startNewTurn: (handle, mergedContent) => this.startNewTurn(handle, mergedContent),
    });
  }

  /**
   * Start a new turn for the given message handle.
   *
   * Orchestrates the full turn setup: session ID rotation, message building,
   * turn creation, acknowledgment, and the async `queueMicrotask` loop.
   * Turn finalisation is always in the `finally` block so the connector state
   * machine always reaches a terminal state.
   * @param handle - The message handle to process
   * @param mergedContent - Optional content from superseded/merged messages
   */
  protected async startNewTurn(handle: MessageHandle, mergedContent?: string[]): Promise<void> {
    this.config.onTurnStart?.(handle);

    // Rotate the adapter-local session ID on every turn (stateless API pattern).
    this.sessionId = crypto.randomUUID();
    handle.adapterSessionId = this.sessionId;

    // Populate adapter-specific messages array before creating the turn.
    this.buildMessages(handle, mergedContent);

    // Create the adapter-specific turn instance.
    this.currentTurn = this.createTurn(handle);

    // Reset content accumulator for this turn.
    this.lastAssistantMessage = undefined;

    handle.markAcknowledged();

    await this.config.emitSdkEvent({
      eventType: 'agent_started',
      model: this.currentModel,
    });

    // Capture the turn reference — this.currentTurn may be overwritten by an
    // immediate message arriving during the async gap below.
    const turn = this.currentTurn;

    // Run turn asynchronously.
    // Turn finalisation (markTurnFinished) is in `finally` to guarantee the
    // turn state machine always reaches a terminal state. The reference
    // claude-code adapter achieves this via event-driven turns; procedural
    // adapters must enforce the invariant explicitly.
    queueMicrotask(async () => {
      try {
        if (!turn) {
          return;
        }
        await this.runTurn(turn, handle);

        // Check if we were superseded during processing.
        if (handle.isProcessed || this.isTurnSuperseded(turn)) {
          return;
        }

        const result = {
          outcome: 'completed' as const,
          result: { message: this.lastAssistantMessage || '' },
        };
        handle.markCompleted(result);
        this.config.onTurnComplete?.(handle, result);
      } catch (error) {
        this.handleTurnError(error, turn, handle);
      } finally {
        // Guarantee turn finalisation: emit turn_finished so the connector
        // transitions through processing_finished → idle (or processes the
        // next queued message). Skipped only for immediate-mode replacement
        // turns where the replacement turn owns finalisation instead.
        if (turn && (!turn.isPaused() || handle.deliveryMode !== 'immediate')) {
          await turn.markTurnFinished();
          if (this.currentTurn === turn) this.currentTurn = undefined;
        }
      }
    });
  }

  /**
   * Handle a turn-level error from the `queueMicrotask` body.
   *
   * Branches on whether the turn was paused (immediate-mode abort or
   * shutdown) and either returns silently, completes the handle with an
   * error result, or delegates to the connector error handler.
   * @param error - The caught error
   * @param turn - The captured turn reference for pause-state checks
   * @param handle - The message handle to finalise on non-abort errors
   */
  private handleTurnError(error: unknown, turn: TTurn | undefined, handle: MessageHandle): void {
    // Aborted for immediate mode — the replacement turn takes over.
    if (turn?.isPaused() && handle.deliveryMode === 'immediate') {
      return;
    }

    const err = error instanceof Error ? error : new Error(String(error));

    // Non-immediate pause means shutdown/interrupt. Complete the handle so
    // lifecycle observers don't wait forever for terminal events.
    if (turn?.isPaused()) {
      if (!handle.isProcessed) {
        const abortResult = { outcome: 'error' as const, error: err };
        handle.markCompleted(abortResult);
        this.config.onTurnComplete?.(handle, abortResult);
      }
      return;
    }

    console.error(`[${this.config.adapterName}] Turn error:`, error);
    if (!handle.isProcessed) {
      const errorResult = { outcome: 'error' as const, error: err };
      handle.markCompleted(errorResult);
      this.config.onTurnComplete?.(handle, errorResult);
    }
    this.config.handleError(err, false);
  }

  /**
   * Run a turn — the agentic loop entry point.
   * @param turn - Captured turn instance for this run loop
   * @param currentHandle - The handle to track supersedence
   */
  protected async runTurn(turn: TTurn, currentHandle: MessageHandle): Promise<void> {
    if (this.isTurnSuperseded(turn)) {
      return;
    }
    await turn.start();
    await this.runTurnIteration(turn, currentHandle);
  }

  /**
   * Wait for the SDK `message_complete` event emitted by stream processing.
   *
   * Uses `bus.once` with AbortSignal support to avoid dangling listeners on
   * abort. Namespace-scoped buses are shared across connector instances, so
   * the filter includes both the event type and adapter identity to prevent
   * concurrent agents from satisfying each other's waiter.
   * @param abortSignal - Abort signal for the current turn
   * @param adapterSessionId - Adapter-local session ID bound to the turn
   * @returns Promise resolving to the SDK event envelope
   */
  protected createMessageCompletePromise(
    abortSignal: AbortSignal,
    adapterSessionId: string,
  ): Promise<{ payload: StreamSdkEventEnvelope }> {
    return this.bus.once(this.getSdkEventSubject(), {
      timeoutMs: 300_000,
      filter: {
        'event.eventType': 'message_complete',
        agentId: this.config.agentId,
        adapterId: this.config.adapterId,
        adapterSessionId,
      } as PayloadFilter,
      signal: abortSignal,
    }) as Promise<{ payload: StreamSdkEventEnvelope }>;
  }

  /**
   * Execute one streaming API step with stream-start-timeout protection.
   *
   * Arms a timeout that aborts the stream connection attempt if no bytes
   * arrive within `streamStartTimeoutMs` (default: 30 s). On timeout a
   * single retry is attempted by `runTurnIteration`. Delegates the actual
   * API call to the abstract `executeApiCall` hook.
   * @param turn - Captured turn instance for this run loop
   * @param abortSignal - Turn-level abort signal
   * @param adapterSessionId - Turn-scoped adapter session ID for event correlation
   */
  protected async executeStreamingStep(turn: TTurn, abortSignal: AbortSignal, adapterSessionId: string): Promise<void> {
    const streamStartTimeoutMs = this.config.streamStartTimeoutMs ?? 30_000;
    const streamStartTimeout = new AbortController();
    const streamStartTimeoutId = setTimeout(() => {
      streamStartTimeout.abort();
    }, streamStartTimeoutMs);

    try {
      await this.executeApiCall(turn, AbortSignal.any([abortSignal, streamStartTimeout.signal]), adapterSessionId);
    } catch (error) {
      if (!abortSignal.aborted && streamStartTimeout.signal.aborted) {
        throw new Error(STREAM_START_TIMEOUT_ERROR);
      }
      throw error;
    } finally {
      clearTimeout(streamStartTimeoutId);
    }
  }

  /**
   * Run one iteration of the agentic loop.
   *
   * Fires the streaming step, waits for the `message_complete` event, then
   * delegates to `applyMessageComplete`. Handles abort signals, stream-start
   * timeouts (with a single retry), and SDK-level errors uniformly.
   * @param turn - Captured turn instance for this run loop
   * @param currentHandle - The handle to track supersedence
   * @param toolCallIteration - Current tool recursion depth (default: 0)
   */
  // eslint-disable-next-line complexity -- Turn loop keeps explicit branch handling to prevent cross-turn contamination.
  protected async runTurnIteration(turn: TTurn, currentHandle: MessageHandle, toolCallIteration = 0): Promise<void> {
    if (this.isTurnSuperseded(turn)) {
      return;
    }
    const abortSignal = turn.getAbortSignal();
    let streamStartAttempt = 0;
    let messageCompletePromise: Promise<{ payload: StreamSdkEventEnvelope }> | undefined;

    while (true) {
      if (this.shouldAbortTurnProcessing(turn, currentHandle)) {
        return;
      }
      try {
        const adapterSessionId = currentHandle.adapterSessionId ?? this.sessionId;
        if (!adapterSessionId) {
          throw new Error('adapterSessionId must be set before waiting for message_complete');
        }
        messageCompletePromise = this.createMessageCompletePromise(abortSignal, adapterSessionId);
        await this.executeStreamingStep(turn, abortSignal, adapterSessionId);

        if (this.shouldAbortTurnProcessing(turn, currentHandle)) {
          // If we stop before awaiting messageCompletePromise, consume any
          // late rejection to prevent unhandled rejection noise.
          void messageCompletePromise.catch(() => {});
          return;
        }

        const { payload } = await messageCompletePromise;
        const event = payload.event;
        if (event.eventType !== 'message_complete') {
          throw new Error(`Expected message_complete event, got ${event.eventType}`);
        }

        if (this.shouldAbortTurnProcessing(turn, currentHandle)) {
          return;
        }

        await this.applyMessageComplete(event as TMessageCompleteEvent, currentHandle, toolCallIteration, turn);
        return;
      } catch (error: unknown) {
        // If streaming failed before awaiting message_complete, consume any
        // late rejection from the once() promise to prevent unhandled
        // rejection noise.
        void messageCompletePromise?.catch(() => {});

        if (
          error instanceof Error &&
          error.message === STREAM_START_TIMEOUT_ERROR &&
          !abortSignal.aborted &&
          streamStartAttempt === 0
        ) {
          streamStartAttempt++;
          continue;
        }

        if (abortSignal.aborted || (error as Error).name === 'AbortError') {
          return;
        }
        if (error instanceof OnceAbortError) {
          return;
        }

        const classifiedError = this.classifyError(error);

        // Only emit the error event at the top-level iteration. Recursive
        // calls (toolCallIteration > 0) re-throw without emitting to avoid
        // N duplicate error events propagating through the call stack.
        if (toolCallIteration === 0) {
          await this.config.emitSdkEvent({
            eventType: 'error',
            message: classifiedError.message,
            code: (error as { code?: string })?.code,
            type: (error as { type?: string })?.type,
          });
        }

        throw classifiedError;
      }
    }
  }

  /**
   * Build the tool execution constraints object from session config.
   *
   * Returns `{ allowedDirectories }` when `config.allowedDirectories` is set,
   * or `undefined` when no directory restrictions are configured. Both
   * concrete adapter sessions call this in `applyMessageComplete` to avoid
   * duplicating the conditional spread.
   * @returns Typed constraints for `ToolExecutionContextOverrides`, or `undefined`
   */
  protected buildToolConstraints(): { allowedDirectories: string[] } | undefined {
    if (this.config.allowedDirectories === undefined) {
      return undefined;
    }
    return { allowedDirectories: this.config.allowedDirectories };
  }

  /**
   * Update the model used for subsequent API calls.
   *
   * Called by the connector's `changeModelInPlace()` to sync the session
   * with the connector-level model without requiring a full session swap.
   * @param model - New model identifier
   */
  public updateModel(model: string): void {
    this.currentModel = model;
  }

  /**
   * Update the working directory used for subsequent tool executions.
   *
   * Called by the connector's `changeCwdInPlace()` to sync the session
   * with the connector-level cwd without requiring a full session swap.
   * @param cwd - New working directory path
   */
  public updateCwd(cwd: string): void {
    this.currentCwd = cwd;
  }

  /**
   * Get the current turn for state inspection.
   * @returns The current turn or `undefined` if no turn is active
   */
  public getCurrentTurn(): TTurn | undefined {
    return this.currentTurn;
  }

  /**
   * Returns true when a newer turn has replaced the captured turn.
   * @param turn - Captured turn reference
   * @returns Whether this turn has been superseded
   */
  protected isTurnSuperseded(turn: TTurn): boolean {
    return this.currentTurn !== turn;
  }

  /**
   * Unified early-exit guard for stale turns and superseded handles.
   * @param turn - Captured turn reference
   * @param currentHandle - Active message handle
   * @returns True when iteration must stop
   */
  protected shouldAbortTurnProcessing(turn: TTurn, currentHandle: MessageHandle): boolean {
    return currentHandle.isProcessed || turn.isPaused() || this.isTurnSuperseded(turn);
  }
}
