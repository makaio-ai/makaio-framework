/* eslint max-lines: ["error", { "max": 650 }] */
import type { Query, SDKUserMessage as SdkSDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, SDKMessage } from '@makaio/client-claude-code';
import {
  BaseConnectorSession,
  SessionLifecycle,
  serializeTurnContext,
  type AIReasoningLevel,
  type MessageHandle,
} from '@makaio/ai-adapters-core';
import { DeferredPromise } from '@makaio/utils';
import { KNOWN_SDK_MESSAGE_TYPES, KNOWN_SYSTEM_SUBTYPES } from '@makaio/client-claude-code';
import { MakaioBus } from '@makaio/bus-core';
import {
  AsyncQuerySource,
  parseResultError,
  prependContextBlock,
  sdkUserMessageFromNormalized,
} from '@makaio/ai-adapters-claude-shared';
import { notifyOnTurnCompleteHook } from './on-turn-complete.js';
import { ClaudeConnectorTurn } from './turn.js';
import { UserMessageQueue, processQueueMessages, formatMessageHistoryAsTranscript } from '@makaio/ai-adapters-core';
import { ClaudeCodeConnectorSubjects } from './namespace/index.js';
import { ClaudeSessionConfig, CreateToolApprovalHandler } from './types/index.js';
import { buildMcpServersRecord, buildQueryOptions } from './utils/buildQueryOptions.js';
import { McpSubjects, type McpResolvedServer } from '@makaio/contracts';

type StreamEvent = { type: string; delta?: { type: string; thinking?: string } };
type StreamEventMessage = Extract<SDKMessage, { type: 'stream_event' }> & { event: StreamEvent };

/**
 * Session for Claude SDK query lifecycle management.
 *
 * Manages a single SDK query instance across multiple turns:
 * - Creates and maintains query instance
 * - Coordinates turn creation and lifecycle
 * - Handles message injection via AsyncQuerySource
 *
 * Key design decisions:
 * - Session persists query across turns (preserves prompt cache)
 * - Turn handles state machine for individual messages
 * - Queue processing delegates to processQueue()
 */
export class ClaudeConnectorSession extends BaseConnectorSession<ClaudeSessionConfig> {
  private queryInstance?: Query;
  private source?: AsyncQuerySource<SdkSDKUserMessage>;
  declare protected currentTurn?: ClaudeConnectorTurn;
  private readonly lifecycle: SessionLifecycle;
  private deferredSessionId = new DeferredPromise<string>();
  private confirmedSessionId = false;
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

  public constructor(config: ClaudeSessionConfig) {
    super(config);
    this.lifecycle = new SessionLifecycle();
    this.mcpServerPort = config.mcpServerPort;
  }

  /**
   * Initialize the session - creates query instance and starts consumption.
   * @param createToolApprovalHandler - Factory for tool approval handler
   */
  public async initialize(createToolApprovalHandler: CreateToolApprovalHandler): Promise<void> {
    this.createToolApprovalHandler = createToolApprovalHandler;
    await this.createQuery(this.config.resumeAdapterSessionId);

    // Register MCP context after query creation so the session ID is known.
    // If registration returns a port, patch the live query's MCP servers so the
    // initial query includes the Makaio MCP proxy (createQuery was built without it).
    await this.refreshMcpContext();

    // Resolve with local session ID for idle initialization (system.init arrives only when SDK processes
    // a real message; for idle agents getAdapterSessionId() would block without this).
    if (!this.confirmedSessionId) {
      this.deferredSessionId.resolve(this.sessionId!);
    }
  }

  /**
   * Register this session with the singleton MCP bridge service via bus RPC.
   * On success stores the returned port in {@link mcpServerPort} for query options.
   * Degrades gracefully when the bridge service is not running (`handled: false`).
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
        env: this.config.env,
        sessionId: makaioSessionId,
        agentId: this.config.agentId,
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
    void MakaioBus.requestOptional(McpSubjects.session.unregister, {
      adapterSessionId: sessionId,
    }).catch(() => {
      // Best-effort cleanup — ignore bridge failures during teardown.
    });
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
   * Create a new query instance (optionally resuming from a previous session).
   * @param resumeSessionId - Optional session ID to resume
   */
  private async createQuery(resumeSessionId?: string) {
    if (!this.createToolApprovalHandler) {
      throw new Error('createToolApprovalHandler not set - initialize() must be called first');
    }

    this.source = new AsyncQuerySource<SdkSDKUserMessage>();

    // Priority: predetermined (swap) > resume (recovery) > generate new
    this.sessionId = this.config.predeterminedSessionId ?? resumeSessionId ?? crypto.randomUUID();
    this.confirmedSessionId = false;
    this.deferredSessionId = new DeferredPromise<string>();

    const queryOptions = buildQueryOptions({
      sessionId: this.sessionId,
      resumeAdapterSessionId: resumeSessionId,
      config: this.config,
      lifecycle: this.lifecycle,
      createToolApprovalHandler: this.createToolApprovalHandler,
      responseSchema: this.config.responseSchema,
      mcpServerPort: this.mcpServerPort,
    });

    this.queryInstance = query({
      prompt: this.source,
      options: queryOptions,
    });

    this.consumptionStarted = false;
    this.startConsumption();
  }

  /**
   * Process messages from the queue (new turn or immediate injection).
   * Serializes concurrent invocations via a re-run flag so calls that arrive
   * while the current run is in progress are not silently dropped.
   * @param queue - User message queue to process
   */
  public async processQueue(queue: UserMessageQueue): Promise<void> {
    if (this.processingQueue) {
      this.reprocessNeeded = true;
      return;
    }
    this.processingQueue = true;
    try {
      await processQueueMessages(queue, {
        getCurrentTurn: () => this.currentTurn,
        onBeforeImmediateTurn: async () => {
          // Rotate query for immediate message; old query's error result is absorbed.
          const previousSessionId = this.sessionId;
          this.unregisterMcpContext();
          try {
            await this.createQuery();
          } catch (error) {
            // createQuery() sets this.sessionId before it can throw — restore the
            // previous ID so MCP context doesn't point to a session that never started.
            this.sessionId = previousSessionId;
            await this.registerMcpContext();
            throw error;
          }
          await this.refreshMcpContext();
        },
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
   * @param handle - Message handle to process
   * @param mergedContent - Optional content from superseded/merged messages (for immediate mode)
   */
  private async startNewTurn(handle: MessageHandle, mergedContent?: string[]): Promise<void> {
    if (!this.queryInstance || !this.source) {
      throw new Error('Session not initialized');
    }

    // Reset thinking accumulation at turn start so stale reasoning is not forwarded
    this.accumulatedThinking = '';

    // Notify connector that turn is starting (sets pendingMessageHandle)
    this.config.onTurnStart?.(handle);

    // Build and inject the SDK message (shared type is a superset of the SDK type).
    const sdkMessage = this.buildSdkMessage(handle, mergedContent);
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

  /**
   * Build an SDK user message with turn context, message history, and any merged content prepended.
   * @param handle - Message handle to process
   * @param mergedContent - Optional content from superseded messages (immediate mode)
   * @returns SDK user message ready to push to source
   */
  private buildSdkMessage(handle: MessageHandle, mergedContent?: string[]): SDKUserMessage {
    let sdkMessage = sdkUserMessageFromNormalized(
      handle.messageId,
      this.sessionId!,
      this.config.agentId,
      handle.message,
    );
    const contextBlocks = serializeTurnContext(handle.turnContext);
    for (let i = contextBlocks.length - 1; i >= 0; i--) {
      const block = contextBlocks[i];
      sdkMessage = prependContextBlock(sdkMessage, block.tag, block.content);
    }

    // Prepend message history if present
    if (handle.messageHistory && handle.messageHistory.length > 0) {
      const historyTranscript = formatMessageHistoryAsTranscript(handle.messageHistory);
      sdkMessage = prependContextBlock(sdkMessage, 'message_history', historyTranscript);
    }

    // Prepend merged content if present (for immediate mode)
    if (mergedContent && mergedContent.length > 0) {
      sdkMessage = prependContextBlock(sdkMessage, 'merged_context', mergedContent.join('\n'));
    }

    return sdkMessage;
  }

  private startConsumption(): void {
    if (this.consumptionStarted) return;
    this.consumptionStarted = true;

    void (async () => {
      if (!this.queryInstance) throw new Error('Query instance not initialized');

      try {
        for await (const msg of this.queryInstance) {
          // Skip unknown message types (e.g., rate_limit_event) that are not in
          // SDKMessageSchema to avoid bus validation errors from newer SDK versions.
          if (!KNOWN_SDK_MESSAGE_TYPES.has(msg.type)) continue;
          // Skip unknown system subtypes (e.g., hook_started, status) that would
          // crash the SDKSystemMessageSchema discriminated union. Log so SDK
          // protocol drift is diagnosable without crashing the consumption loop.
          if (msg.type === 'system' && !KNOWN_SYSTEM_SUBTYPES.has((msg as { subtype?: string }).subtype ?? '')) {
            console.warn('Session: skipping unknown system subtype:', (msg as { subtype?: string }).subtype);
            continue;
          }
          try {
            await this.handleSdkMessage(msg as SDKMessage);
          } catch (error) {
            // Per-message errors are isolated so the consumption loop survives
            // malformed or unexpected messages (e.g., new SDK subtypes) without
            // crashing. Known message routing is deterministic, and
            // post-completion hook failures are detached/logged inside
            // `handleResultMessage()` so they do not escape back into this loop.
            // Iterator-level errors (transport, SDK crash) are caught by the
            // outer try/catch and are fatal.
            console.error('Session: error handling SDK message, skipping:', msg.type, error);
          }
        }
      } catch (error) {
        // Iterator-level errors (transport failure, SDK crash) are fatal.
        console.error('Session consumption error:', error);
        throw error;
      }
    })();
  }

  /**
   * Handle SDK message - update turn state and emit events.
   * @param msg - SDK message from consumption loop
   */
  private async handleSdkMessage(msg: SDKMessage): Promise<void> {
    // Extract session ID from system.init
    if (msg.type === 'system' && msg.subtype === 'init' && !this.confirmedSessionId) {
      this.confirmedSessionId = true;
      this.sessionId = msg.session_id;
      this.deferredSessionId.resolve(msg.session_id);
    }

    // Ignore messages from old/stale queries (happens when createFreshQuery is called)
    const msgSessionId = (msg as { session_id?: string }).session_id;
    if (msgSessionId && msgSessionId !== this.sessionId) {
      return;
    }

    // Only accumulate thinking after stale-session filtering, so old query deltas
    // cannot contaminate tool-approval reasoning for the active session.
    if (msg.type === 'stream_event') {
      const streamMessage = msg as StreamEventMessage;
      const event = streamMessage.event;
      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        this.accumulatedThinking += event.delta.thinking ?? '';
      }
    }

    // Capture current turn BEFORE any state transitions
    const turnForThisMessage = this.currentTurn;

    // Handle message acknowledgment
    if (msg.type === 'user' && (msg as SDKUserMessage & { isReplay?: boolean }).isReplay) {
      turnForThisMessage?.markAcknowledged();
    }

    // Emit SDK event FIRST - must happen before turn completion
    // so that MakaioBus subscribers receive events before waitForCompletion() resolves
    await this.emitSdkEvent(msg);

    // Handle turn completion AFTER emitting event
    if (msg.type === 'result' && turnForThisMessage) {
      this.handleResultMessage(msg, turnForThisMessage);
    }

    // Let turn handle state transitions
    if (turnForThisMessage) {
      await turnForThisMessage.handleSdkEvent(msg);
    }
  }

  /**
   * Complete the turn with success or error based on the result message.
   * SDK quirk: some errors arrive as `subtype: 'success'` with `is_error: true`.
   * @param msg - Result SDK message
   * @param turn - Turn to complete
   */
  private handleResultMessage(
    msg: SDKMessage & { type: 'result'; subtype: string; is_error?: boolean; result?: string },
    turn: ClaudeConnectorTurn,
  ): void {
    // Check if we should absorb this error result (it's from an interrupted query)
    if (turn.isExpectingInterruptResult()) {
      return;
    }

    const handle = turn.getMessageHandle();
    const isSuccess = msg.subtype === 'success' && !msg.is_error;
    const isWeirdSuccessWithError = msg.subtype === 'success' && msg.is_error;

    const result = isSuccess
      ? { outcome: 'completed' as const, result: { message: msg.result } }
      : {
          outcome: 'error' as const,
          error: (() => {
            const parsedError = parseResultError(msg);
            // Ensure error is always an Error object (parseResultError can return string)
            return parsedError instanceof Error ? parsedError : new Error(String(parsedError));
          })(),
          // Preserve result message for success+is_error cases (contains error details)
          result: isWeirdSuccessWithError ? { message: msg.result } : undefined,
        };

    turn.markCompleted(result);

    // `onTurnComplete` is an already-completed notification seam; keep hook failures best-effort.
    if (handle)
      notifyOnTurnCompleteHook({
        onTurnComplete: this.config.onTurnComplete,
        handle,
        result,
        sessionId: this.sessionId,
      });
  }

  /**
   * Emit SDK event via connector callback or direct bus emit.
   * @param msg - SDK message to emit
   */
  private async emitSdkEvent(msg: SDKMessage): Promise<void> {
    if (this.config.emitSdkEvent) {
      await this.config.emitSdkEvent(msg);
    } else {
      await this.bus.emit(ClaudeCodeConnectorSubjects.sdk.event, {
        ...msg,
        agentId: this.config.adapterId,
      } as Parameters<typeof this.bus.emit<typeof ClaudeCodeConnectorSubjects.sdk.event>>[1]);
    }
  }

  /**
   * Abort the session and cleanup resources.
   * Unregisters MCP context before interrupting to prevent stale registry entries.
   */
  public async abort(): Promise<void> {
    this.unregisterMcpContext();
    await this.queryInstance?.interrupt();
    this.lifecycle.abort();
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

  public getCurrentTurn(): ClaudeConnectorTurn | undefined {
    return this.currentTurn;
  }

  public getAccumulatedThinking(): string | undefined {
    return this.accumulatedThinking || undefined;
  }

  /**
   * Gracefully close the session (interrupt, not abort).
   * Unregisters MCP context and absorbs interrupt errors.
   */
  public async close(): Promise<void> {
    this.unregisterMcpContext();
    if (this.queryInstance) {
      try {
        await this.queryInstance.interrupt();
      } catch (error) {
        // Interrupt errors are expected when the query is already done
        console.warn('Session: interrupt failed during close', error);
      }
    }
  }
}
