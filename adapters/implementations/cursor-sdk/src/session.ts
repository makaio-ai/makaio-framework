import {
  processQueueMessages,
  markCompletedWithFinalResult,
  reportBestEffortStages,
  stageFailure,
  formatContextBlockAsText,
  formatContextBlocksAsText,
  formatMessageHistoryAsTranscript,
  serializeTurnContext,
  type MessageHandle,
  type MessageResult,
  type QueueableTurn,
  type UserMessageQueue,
} from '@makaio/ai-adapters-core';
import type { ConnectorTeardownResult } from '@makaio/contracts';
import { registerMcpSession, buildMcpServerConfig, unregisterMcpSession } from './mcp-bridge.js';
import {
  createDeltaHandler,
  createStepHandler,
  createTurnEventState,
  flushAccumulated,
  emitWithMetadata,
  type TurnEventState,
} from './event-routing.js';
import { CursorSdkTurn } from './turn.js';
import { CursorSdkSubjects } from './namespaces/index.js';
import type { CursorSdkBus } from './namespaces/index.js';
import type { CursorSessionConfig } from './types/index.js';
import type { CursorSdkProviderConfig } from './schemas.js';

/**
 * Session initialization configuration for {@link CursorSdkSession}.
 *
 * Extends the base {@link CursorSessionConfig} with the scoped bus and
 * turn lifecycle callbacks needed by the connector layer.
 */
export interface CursorSdkSessionConfig extends CursorSessionConfig {
  /** Scoped bus for emitting turn lifecycle events to the agent layer. */
  bus: CursorSdkBus;
  /**
   * Callback invoked when a new turn starts.
   * Used by the connector to set `pendingMessageHandle` for lifecycle tracking.
   * @param handle - The message handle for the turn being started.
   */
  onTurnStart?: (handle: MessageHandle) => void;
  /**
   * Callback invoked when a turn completes (success or error).
   * Used by the connector to clear `pendingMessageHandle` and record `lastResult`.
   * @param handle - The message handle for the completed turn.
   * @param result - The final message result.
   */
  onTurnComplete?: (handle: MessageHandle, result: MessageResult) => void;
}

/** Subset of Cursor SDK's RunResult needed for completion handling. */
interface CursorRunResult {
  /** Run ID. */
  id: string;
  /** Completion status. */
  status: string;
  /** The assistant's final text response (may be absent on error/cancel). */
  result?: string;
  /** Error details returned by Cursor SDK for failed runs. */
  error?: unknown;
}

/** Minimal Cursor SDK conversation shape needed for assistant-text fallback. */
interface CursorConversationTurn {
  /** Cursor conversation turn discriminator. */
  type: string;
  /** Agent turn payload containing assistant steps. */
  turn?: {
    steps?: Array<{
      type: string;
      message?: { text?: string };
    }>;
  };
}

/** Opaque handle for the active Cursor SDK run's lifecycle methods. */
interface ActiveRun {
  /** Run ID assigned by Cursor SDK. */
  id: string;
  /** Awaitable promise that resolves when the run finishes. */
  wait(): Promise<CursorRunResult>;
  /** Full conversation for the run, used when RunResult omits final text. */
  conversation(): Promise<CursorConversationTurn[]>;
  /** Cancel the in-flight run. */
  cancel(): Promise<void>;
}

/** Minimal Cursor Agent disposal surface used during session close. */
interface CursorAgentDisposable {
  /** Async disposal entry point exposed by Cursor SDK Agent instances. */
  [Symbol.asyncDispose]?: () => Promise<void> | void;
  /** Legacy close method retained as a fallback for compatible agent handles. */
  close?: () => Promise<void> | void;
}

/** Minimal Cursor SDK module surface loaded at runtime. */
interface CursorSdkModule {
  /** Cursor SDK Agent factory. */
  Agent: {
    /** Create a Cursor Agent instance. */
    create(options: {
      agentId?: string;
      apiKey: string;
      model: { id: string };
      local: { cwd: string; settingSources?: string[] };
      mcpServers?: Record<string, { type: 'http'; url: string }>;
      instructions?: string;
      mode?: CursorSdkProviderConfig['mode'];
    }): Promise<unknown>;
  };
}

/**
 * Extract a useful message from an unknown Cursor run error payload.
 * @param error - Raw error payload returned by Cursor SDK.
 * @returns Error message when available.
 */
function getRunErrorMessage(error: unknown): string | undefined {
  if (error == null) return undefined;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const message = (error as Record<string, unknown>)['message'];
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/**
 * Build a framework error for a Cursor run that resolved with an error status.
 * @param runResult - Terminal Cursor SDK run result.
 * @returns Error suitable for a `MessageResult`.
 */
function createRunStatusError(runResult: CursorRunResult): Error {
  const message = getRunErrorMessage(runResult.error);
  return new Error(
    message ? `Cursor SDK run ${runResult.id} failed: ${message}` : `Cursor SDK run ${runResult.id} failed`,
  );
}

/**
 * Dispose a Cursor Agent instance using its preferred async disposal API.
 * @param agent - Cursor Agent instance created by `Agent.create()`.
 */
async function disposeCursorAgent(agent: unknown): Promise<void> {
  const disposable = agent as CursorAgentDisposable;
  const asyncDispose = disposable[Symbol.asyncDispose];
  if (typeof asyncDispose === 'function') {
    await asyncDispose.call(disposable);
    return;
  }
  await disposable.close?.();
}

/**
 * Manages a Cursor SDK Agent lifecycle across multiple turns.
 *
 * One `CursorSdkSession` corresponds to one Cursor Agent instance. The agent
 * is created lazily during {@link initialize} and reused across turns. MCP
 * tool injection is handled via the Makaio MCP bridge (HTTP sidecar).
 *
 * Lifecycle:
 * 1. `initialize()` — registers MCP, creates Cursor Agent.
 * 2. `processQueue()` — dequeues messages and delegates to `startNewTurn()`.
 * 3. `startNewTurn()` — creates a `CursorSdkTurn`, marks it started, fires `runSend()` detached.
 * 4. `runSend()` — calls `agent.send()`, wires delta/step callbacks, awaits `run.wait()`.
 * 5. `completeTurn()` — idempotent finalization: marks handle, finishes turn.
 * 6. `close()` — cancels active run, closes agent, unregisters MCP.
 *
 * Dual-completion guard:
 * Both the `turn-ended` onDelta event (PATH A) and `run.wait()` resolution (PATH B)
 * may attempt to complete the turn. The `completedTurns` WeakSet prevents double-finalization.
 */
export class CursorSdkSession {
  private readonly config: CursorSdkSessionConfig;

  /**
   * Cursor SDK Agent instance — dynamically imported peer dependency.
   * Typed as `unknown` to avoid coupling to `@cursor/sdk` types at compile time.
   */
  private cursorAgent: unknown;

  /** Currently active run handle returned by `agent.send()`. */
  private activeRun: ActiveRun | undefined;

  /** Currently active turn — cleared on turn finalization. */
  private activeTurn: CursorSdkTurn | undefined;

  /** Port of the registered MCP HTTP server (undefined when bridge is unavailable). */
  private mcpServerPort: number | undefined;

  /**
   * Stable adapter session ID generated before `Agent.create()`.
   *
   * This ID is used for both MCP routing and as the public
   * {@link adapterSessionId}. Generating it upfront (rather than reading
   * `agent.agentId` after `Agent.create()`) ensures the MCP URL baked into
   * the Cursor Agent configuration always matches the registered session, with
   * no re-registration required.
   */
  private cursorAgentId: string | undefined;

  /**
   * Mutable model identifier for subsequent `agent.send()` calls.
   * Initialized from `config.model`; updated by {@link updateModel}.
   */
  private currentModel: string;

  /**
   * Per-turn idempotency guard for {@link completeTurn}.
   *
   * Guards against the dual-completion path where both the `turn-ended` onDelta
   * event and `run.wait()` resolve and call `completeTurn()`. Turn-scoped (WeakSet)
   * so a stale `runSend()` from a previous turn cannot steal the guard from a new turn.
   */
  private readonly completedTurns = new WeakSet<CursorSdkTurn>();

  /**
   * Turn-scoped cancellation requests.
   *
   * Immediate replacement can pause a turn before `agent.send()` resolves with
   * a run handle. The cancellation must follow that old turn until its run
   * exists, instead of using a session-wide flag that a replacement turn could
   * accidentally clear.
   */
  private readonly cancelRequestedTurns = new WeakSet<CursorSdkTurn>();

  /** Set to true after {@link close} to block any new turn attempts. */
  private closed = false;

  /**
   * Identity metadata injected into every scoped bus emission.
   *
   * The agent layer subscribes via a filtered bus keyed on `agentId`. Emissions
   * without these fields are invisible to filtered subscriptions and to the
   * agent's `subscribeConnector` wiring.
   */
  private readonly busMetadata: { agentId: string; adapterId: string; adapterName: string };

  /**
   * Create a new Cursor SDK session.
   * @param config - Session configuration including bus, credentials, and MCP context.
   */
  public constructor(config: CursorSdkSessionConfig) {
    this.config = config;
    this.currentModel = config.model;
    this.busMetadata = {
      agentId: config.agentId,
      adapterId: config.adapterId,
      adapterName: config.adapterName,
    };
  }

  /**
   * Emit an event on the scoped bus with auto-injected connector metadata.
   * @param args - Subject and payload forwarded to `bus.emit()`.
   */
  private emitEvent(...args: Parameters<CursorSdkBus['emit']>): void {
    emitWithMetadata(this.config.bus, this.busMetadata, ...args);
  }

  /**
   * The Cursor Agent ID, available after {@link initialize} completes.
   * @returns The adapter session ID or `undefined` before initialization.
   */
  public get adapterSessionId(): string | undefined {
    return this.cursorAgentId;
  }

  /**
   * Update the model used for subsequent `agent.send()` calls.
   *
   * Called by the connector's `changeModelInPlace()` to sync the session model
   * without requiring a session swap. The caller (via the base adapter runtime)
   * owns the `connector.model` field update; this method only updates the
   * session-internal mutable model reference.
   * @param model - New model identifier.
   */
  public updateModel(model: string): void {
    this.currentModel = model;
  }

  /**
   * Get the active turn for queue-processing state inspection.
   *
   * Required by {@link ProceduralConnectorSession} so
   * `ProceduralAgentConnector.acceptsImmediate()` can delegate to the turn's
   * `canAcceptImmediate()` method.
   * @returns The current `CursorSdkTurn`, or `undefined` if no turn is active.
   */
  public getCurrentTurn(): QueueableTurn | undefined {
    return this.activeTurn;
  }

  /**
   * Initialize the session: register MCP bridge, create Cursor Agent.
   *
   * Uses `await import('@cursor/sdk')` to defer the peer-dependency load until
   * the session is actually needed. MCP registration is best-effort — when the
   * bridge is not running the agent is created without MCP tool injection.
   *
   * The adapter session ID is generated upfront so the MCP URL embedded in the
   * Cursor Agent configuration always matches the registered session. No
   * re-registration is needed after `Agent.create()` resolves.
   */
  public async initialize(): Promise<void> {
    // Dynamically import @cursor/sdk (peer dependency — not bundled).
    const cursorSdkModuleName = '@cursor/sdk';
    const { Agent } = (await import(cursorSdkModuleName)) as CursorSdkModule;

    // Generate a stable ID before Agent.create() so the MCP URL embedded in
    // the agent configuration matches the registered session for the full
    // lifetime of this session — no re-registration needed.
    const stableId = `cursor-${crypto.randomUUID()}`;
    this.cursorAgentId = stableId;

    const mcpResult = await registerMcpSession(this.config, stableId);
    this.mcpServerPort = mcpResult.port;

    const mcpServers = buildMcpServerConfig(this.mcpServerPort, stableId);

    try {
      const agent = await Agent.create({
        agentId: stableId,
        apiKey: this.config.apiKey,
        model: { id: this.config.model },
        local: { cwd: this.config.cwd, settingSources: ['project'] },
        ...(mcpServers ? { mcpServers } : {}),
        ...(this.config.systemPrompt ? { instructions: this.config.systemPrompt } : {}),
        ...(this.config.providerConfig?.mode ? { mode: this.config.providerConfig.mode } : {}),
      });

      this.cursorAgent = agent;
    } catch (error) {
      await unregisterMcpSession(stableId);
      this.cursorAgentId = undefined;
      this.mcpServerPort = undefined;
      throw error;
    }
  }

  /**
   * Process queued messages, starting new turns as needed.
   *
   * Delegates to the shared `processQueueMessages` orchestration which handles
   * normal enqueue, replace, and immediate delivery modes uniformly.
   * @param queue - The adapter's user-message queue to drain.
   */
  public async processQueue(queue: UserMessageQueue): Promise<void> {
    await processQueueMessages(queue, {
      getCurrentTurn: () => this.activeTurn,
      startNewTurn: (handle, mergedContent) => this.startNewTurn(handle, mergedContent),
    });
  }

  /**
   * Start a new turn for the given message handle.
   *
   * Creates a `CursorSdkTurn`, marks it as started, and fires `runSend()` as a
   * detached microtask so `processQueue` returns immediately. `agent.send()` is a
   * blocking call that drives the full agentic loop (including all tool round-trips).
   * @param handle - The message handle to process.
   * @param mergedContent - Text from superseded/merged messages (immediate mode).
   */
  private async startNewTurn(handle: MessageHandle, mergedContent?: string[]): Promise<void> {
    this.config.onTurnStart?.(handle);

    const turn = new CursorSdkTurn(
      this.config.bus,
      this.config.adapterId,
      this.config.adapterName,
      this.config.agentId,
      handle,
      (pausedTurn) => this.cancelRunForTurn(pausedTurn),
    );
    this.activeTurn = turn;

    handle.adapterSessionId = this.cursorAgentId;
    handle.markAcknowledged();
    await turn.start();

    const text = this.buildPromptText(handle, mergedContent);

    queueMicrotask(() => {
      void this.runSend(turn, handle, text);
    });
  }

  /**
   * Execute `agent.send()` and finalize the turn on resolution.
   *
   * `agent.send()` resolves immediately and returns a run handle. The turn
   * receives streaming delta events via `onDelta` and step boundaries via `onStep`.
   * `run.wait()` blocks until the full agentic loop completes (PATH B completion).
   *
   * Errors are caught and result in an error-outcome turn completion so the
   * message lifecycle is always resolved cleanly.
   * @param turn - The active turn for this run.
   * @param handle - The message handle being processed.
   * @param text - Fully assembled prompt text.
   */
  private async runSend(turn: CursorSdkTurn, handle: MessageHandle, text: string): Promise<void> {
    if (this.closed) {
      await this.completeTurn(turn, handle, { outcome: 'cancelled' });
      return;
    }

    const state = createTurnEventState();
    const eventConfig = {
      bus: this.config.bus,
      agentId: this.config.agentId,
      metadata: this.busMetadata,
      messageId: handle.messageId,
    };
    const deltaHandler = createDeltaHandler(eventConfig, turn, state);
    const stepHandler = createStepHandler(eventConfig, turn, state);
    let run: ActiveRun | undefined;

    try {
      const agent = this.cursorAgent as {
        send(
          text: string,
          opts: {
            model: { id: string };
            mode?: CursorSdkProviderConfig['mode'];
            onDelta: (event: { update: { type: string; [key: string]: unknown } }) => void;
            onStep: (event: { step: unknown }) => void;
          },
        ): Promise<ActiveRun>;
      };

      run = await agent.send(text, {
        model: { id: this.currentModel },
        ...(this.config.providerConfig?.mode ? { mode: this.config.providerConfig.mode } : {}),
        onDelta: (event) => {
          if (this.isLiveTurn(turn)) deltaHandler(event);
        },
        onStep: (event) => {
          if (this.isLiveTurn(turn)) stepHandler(event);
        },
      });

      if (this.activeTurn === turn) {
        this.activeRun = run;
      }
      // Drain any pause/abort/interrupt that arrived while agent.send() was resolving.
      if (this.cancelRequestedTurns.has(turn)) {
        await this.cancelRun(run, 'deferred cancellation');
        if (!this.isLiveTurn(turn)) return;
      }

      // Emit run.created for observability (fire-and-forget).
      this.emitEvent(CursorSdkSubjects.sdk.event, {
        type: 'run.created',
      });
      this.emitEvent(CursorSdkSubjects.run.created, {
        eventType: 'run.created',
        runId: run.id,
        agentId: this.config.agentId,
        adapterId: this.config.adapterId,
        adapterName: this.config.adapterName,
      });

      // Emit agent_started to drive the turn lifecycle in the agent layer.
      this.emitEvent(CursorSdkSubjects.agent_started, {
        eventType: 'agent_started',
        runId: run.id,
        model: this.currentModel,
      });

      // PATH B: await the run and complete the turn on resolution.
      const runResult = await run.wait();
      const result = await this.buildCompletionResult(run, runResult);
      this.emitCompletion(result, state);
      await this.completeTurn(turn, handle, result);
    } catch (error) {
      if (turn.isPaused()) {
        // The turn was aborted for immediate mode — the replacement turn owns finalization.
        return;
      }

      this.flushAccumulatedContent(state);
      this.emitRunError(error);

      await this.completeTurn(turn, handle, {
        outcome: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    } finally {
      this.cancelRequestedTurns.delete(turn);
      if (this.activeRun === run) {
        this.activeRun = undefined;
      }
    }
  }

  /**
   * Check whether SDK callbacks still belong to the current live turn.
   * @param turn - Turn that owns the callback.
   * @returns True when callback events may still be routed.
   */
  private isLiveTurn(turn: CursorSdkTurn): boolean {
    return this.activeTurn === turn && !this.completedTurns.has(turn) && !turn.isPaused() && !this.closed;
  }

  /**
   * Cancel the run associated with a paused turn.
   * @param turn - Turn being paused or interrupted.
   */
  private async cancelRunForTurn(turn: CursorSdkTurn): Promise<void> {
    this.cancelRequestedTurns.add(turn);
    if (this.activeTurn !== turn) return;
    const run = this.activeRun;
    if (run) {
      await this.cancelRun(run, 'turn pause');
    }
  }

  /**
   * Cancel a Cursor run and normalize diagnostics.
   * @param run - Run handle to cancel.
   * @param reason - Lifecycle phase requesting cancellation.
   */
  private async cancelRun(run: ActiveRun, reason: string): Promise<void> {
    try {
      await run.cancel();
    } catch (err) {
      console.warn(`[CursorSdkSession] Run cancel failed during ${reason}:`, err);
    }
  }

  /**
   * Complete a turn idempotently.
   *
   * Called from two paths:
   * - PATH A: `turn-ended` onDelta event handler (via `event-routing.ts`)
   * - PATH B: `run.wait()` resolution inside {@link runSend}
   *
   * The `completedTurns` WeakSet ensures only the first caller takes effect.
   *
   * Ordering guarantee:
   * 1. Complete the handle and notify `onTurnComplete` with the transformed final result.
   * 2. Emit `turn_finished`, which wires through `ProceduralAgentConnector.wireSessionEvents`
   *    to advance the processing-state machine.
   * @param turn - The turn instance being finalized.
   * @param handle - The message handle for this turn.
   * @param result - The message result to record on the handle.
   */
  private async completeTurn(turn: CursorSdkTurn, handle: MessageHandle, result: MessageResult): Promise<void> {
    if (this.completedTurns.has(turn)) return;
    this.completedTurns.add(turn);

    if (!handle.isProcessed) {
      await markCompletedWithFinalResult(handle, result, this.config.onTurnComplete);
    }

    await turn
      .markTurnFinished()
      .catch((err: unknown) => {
        console.error('[CursorSdkSession] turn.markTurnFinished failed:', err);
      })
      .finally(() => {
        if (this.activeTurn === turn) {
          this.activeTurn = undefined;
        }
      });
  }

  /**
   * Flush any buffered text/thinking content that was not delivered by a step boundary or SDK event.
   * @param state - Mutable turn event state containing the accumulated buffers.
   */
  private flushAccumulatedContent(state: TurnEventState): void {
    flushAccumulated(this.config.bus, this.busMetadata, state);
  }

  /**
   * Emit an error event pair (raw sdk.event + typed error subject).
   * @param error - The error value from the failed run.
   */
  private emitRunError(error: unknown): void {
    this.emitEvent(CursorSdkSubjects.sdk.event, { type: 'error' });
    this.emitEvent(CursorSdkSubjects.error, {
      eventType: 'error',
      error,
      message: error instanceof Error ? error.message : String(error),
      agentId: this.config.agentId,
      adapterId: this.config.adapterId,
      adapterName: this.config.adapterName,
    });
  }

  /**
   * Build the message result from the run's terminal result.
   *
   * Cursor SDK may replay prior conversation text through streaming deltas, so
   * `RunResult.result` is authoritative for the current turn. Persisted
   * conversation assistant text is the next SDK-owned source when the terminal
   * result is absent. Raw text deltas remain observable stream events, but are
   * not semantic completion text because Cursor can replay prior conversation
   * structure through that channel.
   *
   * Usage is NOT emitted here — the `turn-ended` onDelta event already emits usage
   * via `routeUpdate`. Emitting again from `run.wait()` would double-count tokens.
   * @param run - Completed Cursor SDK run used for conversation fallback.
   * @param runResult - The typed result from `run.wait()`.
   * @returns A completed `MessageResult`.
   */
  private async buildCompletionResult(run: ActiveRun, runResult: CursorRunResult): Promise<MessageResult> {
    if (runResult.status === 'error') {
      return { outcome: 'error', error: createRunStatusError(runResult) };
    }
    if (runResult.status === 'cancelled' || runResult.status === 'canceled') {
      return { outcome: 'cancelled' };
    }
    const message = runResult.result || (await this.getConversationAssistantText(run)) || undefined;
    return { outcome: 'completed', result: { message } };
  }

  /**
   * Extract the final assistant text from Cursor's persisted run conversation.
   *
   * `RunResult.result` is optional and streaming deltas can replay prior
   * conversation content, so the persisted conversation is the only fallback
   * used for semantic completion text.
   * @param run - Completed Cursor SDK run.
   * @returns Final assistant text for the run, if present.
   */
  private async getConversationAssistantText(run: ActiveRun): Promise<string | undefined> {
    const conversation = await run.conversation();
    for (let turnIndex = conversation.length - 1; turnIndex >= 0; turnIndex -= 1) {
      const turn = conversation[turnIndex];
      if (turn.type !== 'agentConversationTurn') continue;
      const steps = turn.turn?.steps ?? [];
      for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
        const step = steps[stepIndex];
        if (step.type === 'assistantMessage' && step.message?.text) return step.message.text;
      }
    }
    return undefined;
  }

  /**
   * Emit the normalized completion event after `run.wait()` resolves.
   *
   * Cursor may replay prior conversation text through streaming deltas; the
   * terminal run result is the SDK-owned source of truth for the current turn.
   * @param result - Normalized message result for the current turn.
   * @param state - Turn event state used for duration metadata.
   */
  private emitCompletion(result: MessageResult, state: TurnEventState): void {
    if (result.outcome !== 'completed') return;
    this.emitEvent(CursorSdkSubjects.agent_complete, {
      eventType: 'agent_complete',
      result: result.result?.message,
      durationMs: Date.now() - state.startTime,
    });
  }

  /**
   * Build the full prompt text from a message handle.
   *
   * Combines the primary user message text with any merged content from
   * superseded immediate messages.
   * @param handle - The message handle containing the user message.
   * @param mergedContent - Text from superseded/merged messages (immediate mode).
   * @returns Assembled prompt string.
   */
  private buildPromptText(handle: MessageHandle, mergedContent?: string[]): string {
    const parts: string[] = [];

    if (handle.messageHistory?.length) {
      parts.push(formatContextBlockAsText('message_history', formatMessageHistoryAsTranscript(handle.messageHistory)));
    }

    if (handle.turnContext) {
      const contextText = formatContextBlocksAsText(serializeTurnContext(handle.turnContext));
      if (contextText) parts.push(contextText);
    }

    const userText = handle.message.message ?? '';
    if (userText) parts.push(userText);

    if (mergedContent?.length) parts.push(mergedContent.join('\n\n'));

    return parts.join('\n\n');
  }

  /**
   * Abort the current run (fire-and-forget).
   *
   * Called by the connector's `abort()` for emergency termination. The active
   * turn will eventually complete via the `runSend` error path.
   *
   * Records the active turn in {@link cancelRequestedTurns} via
   * {@link cancelRunForTurn}. If `agent.send()` has not yet resolved and
   * assigned {@link activeRun}, {@link runSend} drains the request as soon as
   * the run becomes available.
   */
  public abort(): void {
    if (!this.activeTurn) return;
    void this.cancelRunForTurn(this.activeTurn);
  }

  /**
   * Interrupt the current run and await its cancellation.
   *
   * Called by the connector's `interrupt()` for graceful mid-turn cancellation.
   *
   * Records the active turn in {@link cancelRequestedTurns} via
   * {@link cancelRunForTurn}. If `agent.send()` has not yet resolved and
   * assigned {@link activeRun}, {@link runSend} drains the request as soon as
   * the run becomes available.
   */
  public async interrupt(): Promise<void> {
    if (!this.activeTurn) return;
    await this.cancelRunForTurn(this.activeTurn);
  }

  /**
   * Close the session, release all resources, and report what was observed.
   *
   * Cancels any active run, closes the Cursor Agent, and unregisters the MCP session.
   * Safe to call even if initialization did not complete.
   *
   * The agent disposal used to fail silently. It still runs best-effort — the MCP
   * unregistration behind it must happen whatever the SDK does — but a session
   * that could not tell whether its own agent was disposed cannot claim to have
   * released it, so the failure now decides the class instead of only reaching a
   * log line.
   * @returns What this session observed about the end of its Cursor Agent.
   */
  public async close(): Promise<ConnectorTeardownResult> {
    this.closed = true;
    const unaccounted: string[] = [];

    if (this.activeRun) {
      await this.cancelRun(this.activeRun, 'close');
    }

    if (this.cursorAgent) {
      try {
        await disposeCursorAgent(this.cursorAgent);
      } catch (err) {
        console.warn('[CursorSdkSession] Agent close failed:', err);
        unaccounted.push(stageFailure('Cursor Agent disposal', err));
      }
    }

    // cursorAgentId is set before Agent.create(), so it is always available when
    // initialization has at least started — covers both fully initialized and
    // in-flight-at-close() scenarios.
    if (this.cursorAgentId) {
      await unregisterMcpSession(this.cursorAgentId);
    }

    this.cursorAgent = undefined;
    this.activeRun = undefined;
    this.activeTurn = undefined;

    const unaccountedReport = reportBestEffortStages('Cursor session close', unaccounted);
    if (unaccountedReport !== undefined) return unaccountedReport;
    return {
      evidence: 'detached',
      detail:
        'The Cursor Agent was disposed and released; the SDK owns the callbacks it was handed, so no end of it is observable here.',
    };
  }
}
