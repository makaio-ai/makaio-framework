/* eslint max-lines: ["error", { "max": 740 }] */
import type { Query, SDKUserMessage as SdkSDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKUserMessage } from '@makaio/client-claude-code';
import { isKnownSdkMessageForRouting } from '@makaio/client-claude-code';
import {
  BaseConnectorSession,
  SessionLifecycle,
  markCompletedWithFinalResult,
  type AIReasoningLevel,
  type MessageHandle,
} from '@makaio/ai-adapters-core';
import { DeferredPromise } from '@makaio/utils';
import { MakaioBus } from '@makaio/bus-core';
import { AsyncQuerySource } from '@makaio/ai-adapters-claude-shared';
import { ClaudeConnectorTurn } from './turn.js';
import { UserMessageQueue, processQueueMessages, rejectQueuedHandles } from '@makaio/ai-adapters-core';
import { buildSdkUserMessage } from './sdk-message-builder.js';
import { ClaudeCodeConnectorSubjects } from './namespace/index.js';
import { ClaudeSessionConfig, CreateToolApprovalHandler } from './types/index.js';
import { buildMcpServersRecord, buildQueryOptions } from './utils/buildQueryOptions.js';
import { McpSubjects, type McpResolvedServer, type ResponseSchemaDescriptor } from '@makaio/contracts';
import { unregisterMcpSession } from './mcp-session-bridge.js';
import { handleClaudeResultMessage } from './result-handling.js';
import { TerminalResultDrain } from './terminal-result-drain.js';

type StreamEvent = { type: string; delta?: { type: string; thinking?: string } };
type StreamEventMessage = Extract<SDKMessage, { type: 'stream_event' }> & { event: StreamEvent };
/**
 * Session for Claude SDK query lifecycle management.
 *
 * Each query generation owns its source and session-ID deferred. A terminal
 * result marks the drain; every other retirement disowns the generation and
 * rejects its unconfirmed session-ID waiters. Queue processing prevents new
 * turns after close and completes queued handles with the closing error.
 *
 * Terminal results mark their generation handled before awaiting finalizers,
 * so close cannot time out while completion hooks run. Every other terminal
 * path clears the query and source before any signal can trigger reuse.
 *
 * Once close begins, setup rechecks the shared closing state after each await.
 * A dequeued handle therefore either starts before shutdown or completes with
 * the same interruption contract as handles that remain queued.
 */
export class ClaudeConnectorSession extends BaseConnectorSession<ClaudeSessionConfig> {
  private queryInstance?: Query;
  private source?: AsyncQuerySource<SdkSDKUserMessage>;
  protected declare currentTurn?: ClaudeConnectorTurn;
  private readonly lifecycle: SessionLifecycle;
  private deferredSessionId = new DeferredPromise<string>();
  private confirmedSessionId = false;
  /** True while a fork directive was consumed but `system.init` has not yet confirmed the child session ID. */
  private awaitingForkConfirmation = false;
  private consumptionStarted = false;
  /** Factory for creating tool approval handlers - stored for fresh query creation */
  private createToolApprovalHandler?: CreateToolApprovalHandler;
  /** Accumulated thinking content from the current turn's thinking_delta stream events */
  private accumulatedThinking = '';
  /** Guard: true while a processQueue invocation is in progress */
  private processingQueue = false;
  /** Set to true when a second processQueue call arrives while one is in flight */
  private reprocessNeeded = false;
  /** Adapter session ID registered with the MCP bridge service, if any */
  private registeredMcpSessionId?: string;
  /** MCP server port; seeded from config, overridden by `mcp.session.register` RPC response */
  private mcpServerPort?: number;
  /** Monotonic owner token for the currently active SDK query. */
  private queryGeneration = 0;
  /** Stable key for the SDK-relevant response schema on the active query. */
  private activeResponseSchemaKey: string | undefined;
  private readonly terminalResultDrain = new TerminalResultDrain();

  public constructor(config: ClaudeSessionConfig) {
    super(config);
    this.lifecycle = new SessionLifecycle();
    this.mcpServerPort = config.mcpServerPort;
  }

  /**
   * Initialize the session - creates query instance and starts consumption.
   * @param createToolApprovalHandler - Factory for tool approval handler
   * @param responseSchema - Optional response schema descriptor for the initial query.
   */
  public async initialize(
    createToolApprovalHandler: CreateToolApprovalHandler,
    responseSchema?: ResponseSchemaDescriptor,
  ): Promise<void> {
    this.createToolApprovalHandler = createToolApprovalHandler;
    await this.createQuery(this.config.resumeAdapterSessionId, responseSchema);

    // Register MCP context after query creation so the session ID is known. If
    // registration returns a port, patch the live query's MCP servers accordingly.
    await this.refreshMcpContext();

    // Resolve with local session ID for idle initialization (system.init arrives only when SDK processes
    // a real message; for idle agents getAdapterSessionId() would block without this).
    if (!this.confirmedSessionId) {
      this.deferredSessionId.resolve(this.sessionId!);
    }
  }

  /**
   * Register this session with the singleton MCP bridge service.
   * On success stores the returned port in {@link mcpServerPort} for query options.
   * Degrades gracefully when the bridge service is not running.
   */
  private async registerMcpContext(): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    this.registeredMcpSessionId = this.sessionId;
    const makaioSessionId = this.config.sessionId ?? this.sessionId;
    // MakaioBus (global singleton) is intentional here — MCP subjects live in
    // the `mcp` namespace, which is unreachable from the adapter's scoped bus.
    // Same pattern used by ToolSubjects.execute and AgentSubjects throughout
    // the adapter layer for all cross-namespace RPCs.
    const result = await MakaioBus.requestOptional(McpSubjects.session.register, {
      adapterSessionId: this.sessionId,
      agentId: this.config.agentId,
      adapterId: this.config.adapterId,
      adapterName: this.config.adapterName,
      sessionId: makaioSessionId,
      contextOverrides: {
        cwd: this.config.cwd,
        env: this.config.contextEnv ?? {},
        sessionId: makaioSessionId,
        agentId: this.config.agentId,
        adapterSessionId: this.sessionId,
      },
    });
    if (result.handled) {
      this.mcpServerPort = result.data.port;
    }
  }

  /**
   * Register with the MCP bridge and, if the port changed, patch the live
   * query's MCP server list. Centralises the register-then-repatch sequence
   * so `initialize()` and immediate-mode rotation stay in sync.
   */
  private async refreshMcpContext(): Promise<void> {
    const previousPort = this.mcpServerPort;
    await this.registerMcpContext();
    if (this.mcpServerPort !== previousPort && this.mcpServerPort !== undefined) {
      await this.updateMcpServers(this.config.mcpUpstreamServers ?? []);
    }
  }

  /**
   * Unregister this session from the singleton MCP bridge service.
   * Fire-and-forget: errors are swallowed to avoid masking the close/abort path.
   */
  private unregisterMcpContext(): void {
    if (!this.registeredMcpSessionId) {
      return;
    }
    const sessionId = this.registeredMcpSessionId;
    this.registeredMcpSessionId = undefined;
    this.mcpServerPort = this.config.mcpServerPort;
    unregisterMcpSession(sessionId);
  }

  public getQueryInstance(): Query | undefined {
    return this.queryInstance;
  }

  /**
   * Persist the reasoning effort into session config so query rotations (immediate-mode)
   * use the updated level rather than silently reverting to the stale value.
   * @param level - New reasoning effort, or `undefined` to omit thinking entirely.
   */
  public updateReasoningEffort(level: AIReasoningLevel | undefined): void {
    this.config.reasoningEffort = level;
  }
  /**
   * @internal Test-only: inject a stub query instance without running initialize().
   * @param instance - Stub providing at minimum `setMcpServers` for updateMcpServers tests.
   */
  public injectQueryInstance(instance: Pick<Query, 'setMcpServers'>): void {
    this.queryInstance = instance as Query;
  }

  /**
   * @internal Test-only seam for driving MCP registration without full SDK lifecycle.
   * @param sessionId - Optional adapter session identifier for registration.
   * @param mode - Whether to run the register or refresh path.
   * @returns Promise that resolves after the requested MCP sync path completes.
   */
  public async syncMcpContextForTest(sessionId?: string, mode: 'register' | 'refresh' = 'register'): Promise<void> {
    if (sessionId !== undefined) this.sessionId = sessionId;
    if (mode === 'refresh') return this.refreshMcpContext();
    await this.registerMcpContext();
  }

  /**
   * Replace the upstream MCP server list and propagate it to the live SDK query.
   * Merges with provider-level static servers and the local Makaio MCP proxy port.
   * @param servers - Resolved MCP servers from the platform registry.
   */
  public async updateMcpServers(servers: McpResolvedServer[]): Promise<void> {
    this.config.mcpUpstreamServers = servers;
    const mcpServers = buildMcpServersRecord(
      servers,
      this.config.providerConfig?.queryOptions?.mcpServers,
      this.mcpServerPort,
    );
    await this.queryInstance?.setMcpServers(mcpServers ?? {});
  }

  /**
   * Detach the active query from session routing before async teardown awaits.
   * Part of the drain/ownership contract: MUST be called on every exit path.
   * @param retirementError - Terminal error exposed to unconfirmed session-ID waiters.
   * @returns Query instance that was active before detaching, when present.
   */
  private disownActiveQuery(retirementError?: Error): Query | undefined {
    const activeQuery = this.queryInstance;
    if (activeQuery || this.source) {
      this.queryGeneration += 1;
      if (!this.confirmedSessionId) {
        this.rejectDeferredSessionId(
          retirementError ?? new Error('Claude query retired before session ID was confirmed'),
        );
      }
    }
    this.source?.complete();
    this.source = undefined;
    this.queryInstance = undefined;
    this.consumptionStarted = false;
    return activeQuery;
  }

  /**
   * Reject a session-ID deferred even when the public waiter attaches later.
   * @param error - Terminal cause for session-ID waiters.
   * @param deferredSessionId - Deferred owned by the retiring generation.
   */
  private rejectDeferredSessionId(error: Error, deferredSessionId = this.deferredSessionId): void {
    void deferredSessionId.getPromise().catch(() => undefined);
    deferredSessionId.reject(error);
  }

  /**
   * Create a new query instance (optionally resuming from a previous session).
   * @param resumeSessionId - Optional session ID to resume
   * @param responseSchema - Optional response schema descriptor for SDK outputFormat.
   */
  private async createQuery(resumeSessionId?: string, responseSchema?: ResponseSchemaDescriptor) {
    if (!this.createToolApprovalHandler) {
      throw new Error('createToolApprovalHandler not set - initialize() must be called first');
    }

    const source = new AsyncQuerySource<SdkSDKUserMessage>();
    const sessionId = this.config.predeterminedSessionId ?? resumeSessionId ?? crypto.randomUUID();
    const deferredSessionId = new DeferredPromise<string>();
    const forkDirective = resumeSessionId === undefined ? this.config.nativeFork : undefined;
    const awaitingForkConfirmation = forkDirective !== undefined;
    let queryInstance: Query;
    try {
      const queryOptions = buildQueryOptions({
        sessionId,
        resumeAdapterSessionId: resumeSessionId,
        nativeFork: forkDirective,
        config: this.config,
        lifecycle: this.lifecycle,
        createToolApprovalHandler: this.createToolApprovalHandler,
        mcpServerPort: this.mcpServerPort,
        responseSchema,
      });
      queryInstance = query({ prompt: source, options: queryOptions });
    } catch (error) {
      const constructionError = error instanceof Error ? error : new Error(String(error));
      source.complete();
      if (!this.confirmedSessionId) {
        this.sessionId = undefined;
        this.deferredSessionId = deferredSessionId;
        this.awaitingForkConfirmation = false;
        this.rejectDeferredSessionId(constructionError, deferredSessionId);
      }
      throw constructionError;
    }

    this.source = source;
    this.sessionId = sessionId;
    this.confirmedSessionId = false;
    this.deferredSessionId = deferredSessionId;
    this.awaitingForkConfirmation = awaitingForkConfirmation;
    if (forkDirective) this.config.nativeFork = undefined;
    this.queryInstance = queryInstance;
    const queryGeneration = ++this.queryGeneration;
    this.activeResponseSchemaKey = this.getResponseSchemaKey(responseSchema);
    this.consumptionStarted = false;
    this.startConsumption(queryGeneration);
  }

  /**
   * Key the active query by the SDK-visible JSON schema.
   * @param responseSchema - Optional per-turn response schema descriptor.
   * @returns Comparable schema key for the active query.
   */
  private getResponseSchemaKey(responseSchema: ResponseSchemaDescriptor | undefined): string | undefined {
    return responseSchema === undefined ? undefined : JSON.stringify(responseSchema.schema);
  }

  /**
   * Ensure the active SDK query matches the required response schema.
   * Schema changes are query boundaries (SDK accepts `outputFormat` only at
   * `query()` time). Resumes only after `system.init` confirms a session ID.
   * @param responseSchema - Optional per-turn response schema descriptor.
   * @returns True when a new SDK query was created.
   */
  private async ensureQueryForResponseSchema(responseSchema: ResponseSchemaDescriptor | undefined): Promise<boolean> {
    const nextKey = this.getResponseSchemaKey(responseSchema);
    if (this.queryInstance && this.activeResponseSchemaKey === nextKey) {
      return false;
    }

    const resumeSessionId = this.confirmedSessionId ? this.sessionId : undefined;
    const oldQuery = this.disownActiveQuery();
    oldQuery?.close();
    if (resumeSessionId === undefined && this.registeredMcpSessionId !== undefined) {
      this.unregisterMcpContext();
    }
    await this.createQuery(resumeSessionId, responseSchema);
    await this.refreshMcpContext();
    return true;
  }

  /**
   * Process messages from the queue (new turn or immediate injection).
   * Serializes via a re-run flag so concurrent calls are not silently dropped.
   *
   * Refuses to start new turns once the session is closing: any remaining
   * queued handles are drained with an error outcome so callers awaiting
   * `waitForCompletion()` resolve deterministically.
   * @param queue - User message queue to process
   */
  public async processQueue(queue: UserMessageQueue): Promise<void> {
    if (this.closing) {
      rejectQueuedHandles(queue);
      return;
    }
    if (this.processingQueue) {
      this.reprocessNeeded = true;
      return;
    }
    this.processingQueue = true;
    try {
      await processQueueMessages(queue, {
        getCurrentTurn: () => this.currentTurn,
        startNewTurn: (handle, mergedContent) => this.startNewTurn(handle, mergedContent),
      });
    } finally {
      this.processingQueue = false;
      if (this.reprocessNeeded) {
        this.reprocessNeeded = false;
        await this.processQueue(queue);
      }
    }
  }

  /**
   * Start a new turn with the given message.
   *
   * Returns `false` when shutdown interleaved during setup and no turn was
   * started. The SDK connector does not currently consume this value (its
   * `turn_finished` handler uses queue emptiness to decide idle), but the
   * shared `processQueueMessages` contract requires an accurate signal so
   * any future caller sees a consistent "no turn started" result.
   * @param handle - Message handle to process
   * @param mergedContent - Optional content from superseded/merged messages (for immediate mode)
   * @returns `false` when the turn was skipped due to shutdown; `void` otherwise
   */
  private async startNewTurn(handle: MessageHandle, mergedContent?: string[]): Promise<void | false> {
    const schemaKey = this.getResponseSchemaKey(handle.responseSchema);
    const pausedTurnNeedsSchemaRotation = this.currentTurn?.isPaused() && this.activeResponseSchemaKey !== schemaKey;
    if (!this.currentTurn || this.currentTurn.isCompleted() || pausedTurnNeedsSchemaRotation) {
      await this.ensureQueryForResponseSchema(handle.responseSchema);
      // Recheck: close() may have started during schema rotation / query
      // creation / MCP registration. The handle is dequeued and unreachable
      // by rejectQueuedHandles — complete it here instead of proceeding.
      // Return false so processQueueMessages reports "no turn started".
      if (this.completeHandleIfClosing(handle)) return false;
      if (pausedTurnNeedsSchemaRotation) {
        this.currentTurn = undefined;
      }
    }

    // Guard after ensureQueryForResponseSchema: after an iterator-level error
    // the dead query is disowned (queryInstance/source cleared), and
    // ensureQueryForResponseSchema above recreates them. If this guard fires,
    // the session was never initialized at all (no prior initialize() call).
    if (!this.queryInstance || !this.source) {
      // Complete the handle so the caller does not hang on waitForCompletion().
      if (!handle.isProcessed) {
        handle.markCompleted({
          outcome: 'error',
          error: new Error('Session not initialized'),
        });
      }
      throw new Error('Session not initialized');
    }

    // Reset thinking accumulation at turn start so stale reasoning is not forwarded
    this.accumulatedThinking = '';

    // Notify connector that turn is starting (sets pendingMessageHandle)
    this.config.onTurnStart?.(handle);

    // Build and inject the SDK message (shared type is a superset of the SDK type).
    const sdkMessage = buildSdkUserMessage(handle, this.sessionId!, this.config.agentId, mergedContent);

    if (this.currentTurn?.isPaused()) {
      this.currentTurn.setActiveMessageHandle(handle);
      await this.currentTurn.resume();
      this.source.push(sdkMessage as SdkSDKUserMessage);
      return;
    }

    this.source.push(sdkMessage as SdkSDKUserMessage);

    // Create turn
    this.currentTurn = new ClaudeConnectorTurn(
      this.bus,
      ClaudeCodeConnectorSubjects,
      this.config.adapterId,
      this.config.adapterName,
      this.config.agentId,
      this.queryInstance,
      handle,
    );

    await this.currentTurn.start();
  }

  private startConsumption(queryGeneration: number): void {
    if (this.consumptionStarted) return;
    const queryInstance = this.queryInstance;
    if (!queryInstance) return;
    this.consumptionStarted = true;

    void (async () => {
      try {
        for await (const msg of queryInstance) {
          if (queryGeneration !== this.queryGeneration) return;
          try {
            await this.handleSdkMessage(msg, queryGeneration);
          } catch (error) {
            // Per-message errors are isolated so the consumption loop survives
            // malformed or unexpected messages (e.g., new SDK subtypes) without
            // crashing. Known message routing is deterministic, and
            // post-completion hook failures are detached/logged inside
            // `handleResultMessage()` so they do not escape back into this loop.
            // Iterator-level errors (transport, SDK crash) are caught by the
            // outer try/catch and are fatal.
            console.error('Session: error handling SDK message, skipping:', (msg as { type?: unknown }).type, error);
          }
        }
        const eofOutcome = this.closing ? 'interrupted' : 'ended';
        await this.handleConsumptionError(
          new Error(`Claude query ${eofOutcome} before terminal result`),
          queryGeneration,
        );
      } catch (error) {
        // Iterator-level errors (transport failure, SDK crash) must complete
        // the active handle: otherwise callers wait forever for a result that
        // the SDK can no longer produce.
        console.error('Session consumption error:', error);
        await this.handleConsumptionError(error, queryGeneration);
      }
    })();
  }

  /**
   * Handle an iterator-level error (transport failure, SDK crash).
   * Unconditionally disowns the dead query (drain/ownership contract) so
   * {@link ensureQueryForResponseSchema} never reuses a dead source.
   * @param error - The error thrown by the SDK async iterator.
   * @param queryGeneration - Owner token captured when this consumption loop started.
   */
  private async handleConsumptionError(error: unknown, queryGeneration: number): Promise<void> {
    if (queryGeneration !== this.queryGeneration) return;
    const normalizedError = error instanceof Error ? error : new Error(String(error));

    // Force-close this generation so (a) the drain deferred resolves and
    // (b) hasHandled() returns true, preventing any late SDK result that
    // arrives while we await completion transforms / finishOnError below
    // from passing both the queryGeneration guard and the hasHandled()
    // check in handleSdkMessage().
    this.terminalResultDrain.forceClose(queryGeneration);

    // Disown unconditionally: whether the turn is incomplete, already
    // completed, or absent, the dead query must be detached so that the next
    // message triggers a fresh query via ensureQueryForResponseSchema.
    this.disownActiveQuery(normalizedError);

    const turn = this.currentTurn;
    if (!turn || turn.isCompleted()) return;

    const result = { outcome: 'error' as const, error: normalizedError };
    const handle = turn.getMessageHandle();
    if (handle) {
      await markCompletedWithFinalResult(handle, result, this.config.onTurnComplete);
    } else {
      turn.markCompleted(result);
    }

    await turn.finishOnError();
  }

  private async completeInterruptedTurnAfterDrainTimeout(queryGeneration: number): Promise<void> {
    if (queryGeneration !== this.queryGeneration || this.currentTurn?.isCompleted()) return;
    await this.handleConsumptionError(new Error('Claude query interrupted before terminal result'), queryGeneration);
  }

  /**
   * Handle SDK message — update turn state and emit events.
   *
   * For terminal `result` messages, marks the drain handled BEFORE awaiting
   * turn finalizers (see drain/ownership contract on the class).
   * @param msg - SDK message from consumption loop
   * @param queryGeneration - Owner token captured when this consumption loop started
   */
  private async handleSdkMessage(msg: unknown, queryGeneration: number): Promise<void> {
    if (queryGeneration !== this.queryGeneration) return;

    if (!isKnownSdkMessageForRouting(msg)) {
      await this.emitSdkEvent(msg);
      return;
    }
    const sdkMessage = msg;

    if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init' && !this.confirmedSessionId) {
      this.confirmedSessionId = true;
      this.awaitingForkConfirmation = false;
      this.sessionId = sdkMessage.session_id;
      // Defense-in-depth: already consumed at first read in createQuery, but
      // clear again so the invariant holds even if the read path changes.
      this.config.nativeFork = undefined;
      // Resolve the live deferred instead of replacing it. A query rotation
      // installs a fresh, unresolved deferred (see createQuery), and callers
      // such as the connector's sendMessage() capture its promise before
      // system.init arrives. Replacing the instance here would leave those
      // captured promises pending forever — the turn then hangs until the
      // caller's send timeout fires. Resolving an already-settled deferred is
      // a no-op, so the eager local-ID resolve from initialize() stays benign.
      this.deferredSessionId.resolve(sdkMessage.session_id);
    }

    // Ignore stale-session messages once the provider session ID is confirmed.
    const msgSessionId = (sdkMessage as { session_id?: string }).session_id;
    if (msgSessionId && msgSessionId !== this.sessionId) {
      return;
    }

    if (sdkMessage.type === 'result' && this.terminalResultDrain.hasHandled(queryGeneration)) {
      return;
    }

    // Emit SDK event before turn completion so MakaioBus subscribers receive
    // events before waitForCompletion() resolves.
    await this.emitSdkEvent(sdkMessage);

    // Only accumulate thinking after stale-session filtering, so old query deltas
    // cannot contaminate tool-approval reasoning for the active session.
    if (sdkMessage.type === 'stream_event') {
      const streamMessage = sdkMessage as StreamEventMessage;
      const event = streamMessage.event;
      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        this.accumulatedThinking += event.delta.thinking ?? '';
      }
    }

    // Mark the drain handled BEFORE awaiting turn finalizers (completion
    // transforms, onTurnComplete) so the close() drain resolves immediately
    // when a terminal result is accepted. Without this, a slow onTurnComplete
    // or structured-output validation exceeding 250 ms causes the drain to
    // time out and fire the interruption error path even though a real result
    // was already accepted and emitted.
    //
    // Gate on the turn actually accepting the result: when the turn is
    // expecting an interrupt result (immediate-message pause flow), the
    // result will be absorbed by handleClaudeResultMessage() and the
    // resumed message handle remains incomplete. Satisfying the drain
    // here would cause close() to skip completeInterruptedTurnAfterDrainTimeout()
    // and tear down without completing the active handle.
    if (sdkMessage.type === 'result' && !this.currentTurn?.isExpectingInterruptResult()) {
      this.terminalResultDrain.markHandled(queryGeneration);
    }

    await this.handleTurnSdkEvent(sdkMessage);
  }

  /**
   * Apply an SDK message to the active turn after connector-level emission.
   * @param sdkMessage - Routed SDK message.
   */
  private async handleTurnSdkEvent(sdkMessage: SDKMessage): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) return;

    if (sdkMessage.type === 'user' && (sdkMessage as SDKUserMessage & { isReplay?: boolean }).isReplay) {
      turn.markAcknowledged();
    }
    if (sdkMessage.type === 'result') {
      await handleClaudeResultMessage(sdkMessage, turn, this.config.onTurnComplete);
    }
    await turn.handleSdkEvent(sdkMessage);
  }

  /**
   * Emit SDK event via connector callback or direct bus emit.
   *
   * The payload is intentionally `unknown`: this method forwards raw SDK output
   * that may not yet match `SDKMessage`. The casts are confined to the two
   * forwarding paths — `this.config.emitSdkEvent` receives the raw SDK message,
   * while `this.bus.emit(ClaudeCodeConnectorSubjects.sdk.event)` attaches
   * metadata for lenient validation and drift reporting.
   * @param msg - SDK message to emit
   */
  private async emitSdkEvent(msg: unknown): Promise<void> {
    if (this.config.emitSdkEvent) {
      await this.config.emitSdkEvent(msg);
    } else {
      await this.bus.emit(ClaudeCodeConnectorSubjects.sdk.event, {
        ...(msg as Record<string, unknown>),
        agentId: this.config.agentId,
      } as Parameters<typeof this.bus.emit<typeof ClaudeCodeConnectorSubjects.sdk.event>>[1]);
    }
  }

  /**
   * Abort the session and cleanup resources.
   *
   * Delegates to {@link close} for the interrupt/drain/disown sequence — the
   * only additional semantic is the terminal `lifecycle.abort()` transition.
   * This mirrors the CLI adapter's approach and eliminates duplicated teardown
   * logic (including the try/catch around `interrupt()` that `close()` owns).
   */
  public async abort(): Promise<void> {
    try {
      await this.close();
    } finally {
      this.lifecycle.abort();
    }
  }

  /** Interrupt the current turn processing. */
  public async interrupt(): Promise<void> {
    await this.queryInstance?.interrupt();
  }

  /**
   * Not used — message delivery goes through processQueue().
   * @param _message - Unused
   * @param _options - Unused
   */
  public async sendMessage(_message: unknown, _options?: unknown): Promise<void> {
    throw new Error('Use processQueue instead');
  }

  /**
   * Get the adapter session ID.
   * @returns The session ID from the provider
   */
  public async getAdapterSessionId(): Promise<string> {
    if (this.confirmedSessionId) return this.sessionId!;
    return this.deferredSessionId.getPromise();
  }

  /**
   * Return the provider-confirmed session ID, or `undefined` when unconfirmed.
   *
   * For non-fork sessions the locally-generated ID is authoritative (the SDK
   * will echo it back in `system.init`) so it is returned immediately.
   * For fork sessions the provider assigns a new child ID, so this returns
   * `undefined` until `system.init` confirms it.
   *
   * Unlike {@link getAdapterSessionId} this never blocks — it reflects the
   * current confirmation state synchronously.
   * @returns Confirmed session ID or `undefined`
   */
  public getConfirmedSessionId(): string | undefined {
    if (this.confirmedSessionId) return this.sessionId;
    // Non-fork: local ID is authoritative; fork: wait for system.init.
    return this.awaitingForkConfirmation ? undefined : this.sessionId;
  }

  public getCurrentTurn(): ClaudeConnectorTurn | undefined {
    return this.currentTurn;
  }

  public getAccumulatedThinking(): string | undefined {
    return this.accumulatedThinking || undefined;
  }

  /**
   * Gracefully close the session (interrupt, not abort).
   * Sets the closing flag to prevent new turns from starting, then
   * unregisters MCP context and absorbs interrupt errors.
   */
  public async close(): Promise<void> {
    this.closing = true;
    this.unregisterMcpContext();
    const activeQuery = this.queryInstance;
    const queryGeneration = this.queryGeneration;
    const terminalResultDrain =
      activeQuery && this.currentTurn && !this.currentTurn.isCompleted()
        ? this.terminalResultDrain.waitForResult(queryGeneration)
        : undefined;
    if (activeQuery) {
      try {
        await activeQuery.interrupt();
      } catch (error) {
        // Interrupt errors are expected when the query is already done
        console.warn('Session: interrupt failed during close', error);
      } finally {
        const receivedTerminalResult = await terminalResultDrain;
        if (receivedTerminalResult === false) {
          await this.completeInterruptedTurnAfterDrainTimeout(queryGeneration);
        }
        this.disownActiveQuery();
        activeQuery.close();
      }
    }
  }
}
