import type { PermissionResult, PermissionUpdate, Options } from '@anthropic-ai/claude-agent-sdk';
import {
  AIAgentConnector,
  isMcpCallTool,
  extractMcpCallTarget,
  type NormalizedMessageInput,
  type AgentStartResult,
  type MessageResult,
  ConnectorSendMessageOptions,
  ConnectorStartOptions,
  MessageHandle,
  AIReasoningLevel,
} from '@makaio/ai-adapters-core';
import {
  parseReasoningLevel,
  readClaudeProviderBaseUrl,
  resolveClaudeProcessEnv,
} from '@makaio/ai-adapters-claude-process-shared';
import { type SDKMessage } from '@makaio/ai-adapters-claude-shared';
import { MakaioBus, NoHandlerError, RequestError } from '@makaio/bus-core';
import { McpSubjects, type McpSessionContext, type SystemPrompt } from '@makaio/contracts';
import { type ClaudeCodeConnectorBus, ClaudeCodeConnectorSubjects } from './namespace/index.js';
import { InvalidModelError } from '@makaio/core';
import type { ClaudeAgentConfig, ClaudeSessionConfig } from './types/index.js';
import { ClaudeCodeAdapterName } from './adapter.js';
import { UserMessageQueue } from '@makaio/ai-adapters-core';
import { ClaudeConnectorSession } from './session.js';
import { ClaudeAccountObservationEmitter } from './account-observation.js';
import type { RequestSessionAccountObservation } from './account-observation-requester.js';

const SDK_METADATA_KEYS = ['agentId', 'adapterId', 'adapterSessionId', 'adapterName'] as const;
type ConnectorSdkEventPayload = Omit<SDKMessage, (typeof SDK_METADATA_KEYS)[number]>;

const hasMcpResolutionScope = (context: unknown): context is McpSessionContext =>
  context !== null && typeof context === 'object' && 'projectId' in context && 'profileId' in context;

type ClaudeConnectorConfig = ClaudeAgentConfig & {
  clientId: string;
  requestSessionAccountObservation: RequestSessionAccountObservation;
};

/**
 * Remove connector-managed metadata keys so `emit()` can inject canonical values.
 * @param payload - Raw SDK event payload received from the provider.
 * @returns SDK payload without connector-managed metadata fields, or undefined for non-object payloads
 */
function stripSdkMetadata(payload: unknown): ConnectorSdkEventPayload | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const sanitized: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const key of SDK_METADATA_KEYS) {
    delete sanitized[key];
  }
  return sanitized as ConnectorSdkEventPayload;
}

/**
 * Wraps a single Claude Agent SDK query() for one provider session.
 *
 * This is the SDK-level connector layer in the three-layer architecture.
 * It handles all direct SDK interactions and emits events to the scoped bus.
 *
 * Responsibilities:
 * - Manages the Claude SDK query() lifecycle
 * - Emits messages to adapter bus via processSDKMessage
 * - Exposes SDK namespace subjects for direct runtime control (setModel, interrupt, etc.)
 * - Handles tool approval via scoped bus (agent.ts wires to global)
 *
 * Session closed events are now handled by the AIAgent layer (ClaudeCodeAgent),
 * not here in the connector.
 */
export class ClaudeSdkConnector extends AIAgentConnector<ClaudeCodeConnectorBus> {
  /** Runtime system prompt configuration from options (session-level, set once) */
  private runtimeSystemPrompt?: SystemPrompt;

  /** Session abstraction handling SDK query lifecycle */
  private session?: ClaudeConnectorSession;
  /** User message queue for Session processing */
  private userMessageQueue?: UserMessageQueue;
  /** Whether turn event wiring has been setup */
  private turnEventsWired = false;
  /** Whether upstream MCP servers should be refreshed before the next queued turn. */
  private hasPendingToolRefresh = false;
  /** Deduplicates session-scoped account observations across successful turns. */
  private readonly accountObservationEmitter: ClaudeAccountObservationEmitter;

  public constructor(config: ClaudeConnectorConfig) {
    // Call super with BaseAgentConfig + adapterId + adapterName
    super({
      ...config,
      // adapterId and adapterName now come from config (required for three-layer architecture)
      adapterId: config.adapterId,
      adapterName: config?.adapterName ?? ClaudeCodeAdapterName,
    });
    this.accountObservationEmitter = new ClaudeAccountObservationEmitter(
      config.requestSessionAccountObservation,
      config.clientId,
    );
  }

  // ============================================================================
  // Session/Turn lifecycle management
  // ============================================================================

  /**
   * Initialize Session and UserMessageQueue for SDK lifecycle management.
   * Called on first start() to setup Session/Turn abstractions.
   * @param responseSchema - Optional schema used to create the initial SDK query with outputFormat.
   */
  private async initializeSession(responseSchema?: ConnectorStartOptions['responseSchema']): Promise<void> {
    // Validate model early to fail fast with clear error
    if (!this.model || this.model.trim() === '') {
      throw new InvalidModelError('Model is required but was not provided');
    }

    // Create session config
    const agentConfig = this.config as ClaudeAgentConfig;

    // Central client resolution is authoritative whenever it selected an
    // executable. A null path deliberately leaves discovery to the SDK; never
    // replace it with a bare command because the SDK expects this option to be
    // an executable path rather than performing shell PATH lookup itself.
    const selectedClaudeExecutable = agentConfig.clientExecution?.binaryPath ?? undefined;
    const { pathToClaudeCodeExecutable: _discardedProviderExecutable, ...queryOptionsWithoutExecutable } =
      agentConfig.providerConfig?.queryOptions ?? {};
    const resolvedProviderConfig = {
      ...agentConfig.providerConfig,
      queryOptions: {
        ...queryOptionsWithoutExecutable,
        ...(selectedClaudeExecutable !== undefined && {
          pathToClaudeCodeExecutable: selectedClaudeExecutable,
        }),
      },
    };
    const sessionEnv = resolveClaudeProcessEnv({
      spawnEnv: this.env,
      baseUrl: readClaudeProviderBaseUrl(resolvedProviderConfig),
    });

    const sessionConfig: ClaudeSessionConfig = {
      bus: this.config.bus as ClaudeCodeConnectorBus,
      adapterId: this.adapterId,
      adapterName: this.adapterName,
      agentId: this.agentId,
      sessionId: this.sessionId,
      clientId: this.config.clientId,
      cwd: this.cwd,
      model: this.model,
      env: sessionEnv,
      contextEnv: agentConfig.contextEnv ?? {},
      reasoningEffort: this.config.reasoningEffort,
      providerConfig: resolvedProviderConfig,
      systemPrompt: this.runtimeSystemPrompt,
      resumeAdapterSessionId: this.config.resumeAdapterSessionId,
      nativeFork: agentConfig.nativeFork,
      predeterminedSessionId: this.config.adapterSessionId,
      mcpUpstreamServers: agentConfig.mcpUpstreamServers,
      ephemeral: agentConfig.ephemeral,
      // Emit SDK events through connector for proper metadata injection
      emitSdkEvent: async (msg) => {
        this.logLowLevelEvent(msg);
        // Sync adapterSessionId from Session before emitting to ensure correct metadata.
        // This handles the case where system.init arrives before start() returns.
        //
        // Must use the non-blocking getConfirmedSessionId(): the session drains
        // the SDK message stream serially and emits every message it cannot
        // route through here. Claude Code emits pre-init traffic (operational
        // `system` subtypes such as hook lifecycle records, and top-level types
        // the client does not model yet) BEFORE system.init. Awaiting the
        // blocking getAdapterSessionId() on such a message parks the drain on a
        // promise that only system.init can settle — which that same drain is
        // the only thing able to deliver. The turn then never starts.
        const confirmedSessionId = this.session?.getConfirmedSessionId();
        if (confirmedSessionId !== undefined && confirmedSessionId !== this.adapterSessionId) {
          this.adapterSessionId = confirmedSessionId;
        }
        const sdkEventPayload = stripSdkMetadata(msg);
        if (!sdkEventPayload) {
          console.warn('[ClaudeSdkConnector] Dropping non-object SDK event payload', { payloadType: typeof msg });
          return;
        }
        const originatingMessageId = this.pendingMessageHandle?.messageId;
        await this.emit(ClaudeCodeConnectorSubjects.sdk.event, {
          ...sdkEventPayload,
          ...(originatingMessageId !== undefined && { originatingMessageId }),
        } as never);
      },
      // Track pending message for error handling (handleError needs this)
      onTurnStart: (handle) => {
        this.pendingMessageHandle = handle;
      },
      // Track completion result for agent.complete() return value
      onTurnComplete: (_handle, result) => {
        this.lastResult = result;
        this.pendingMessageHandle = undefined;
        // Account observation is a post-completion side effect. The session
        // awaits this callback as the final-result lifecycle barrier, so keep
        // observation best-effort and non-blocking.
        void this.emitCompletedTurnAccountObservation(result).catch(() => undefined);
      },
    };

    this.session = new ClaudeConnectorSession(sessionConfig);
    this.userMessageQueue = new UserMessageQueue();

    // Initialize session with tool approval handler
    await this.session.initialize(() => this.createToolApprovalHandler(), responseSchema);

    // Wire turn events for state updates
    this.wireSessionEvents();
  }

  /**
   * Wire Session turn events to Connector state updates.
   * Subscribes to typed namespace subjects for turn state changes.
   */
  private wireSessionEvents(): void {
    if (this.turnEventsWired) return;
    this.turnEventsWired = true;

    // Subscribe to turn_started for state update (triggers processing_started via prerequisites)
    this.on(ClaudeCodeConnectorSubjects.turn.turn_started, async () => {
      this.consumeTurnNumber();
      await this.updateProcessingState('turn_started');
    });

    // Subscribe to turn step_started for state update
    this.on(ClaudeCodeConnectorSubjects.turn.step_started, async () => {
      await this.updateProcessingState('step_started');
    });

    // Subscribe to turn step_finished for state update and queue processing
    this.on(ClaudeCodeConnectorSubjects.turn.step_finished, async () => {
      await this.updateProcessingState('step_finished');

      // Process queue on step_finished for immediate messages
      if (this.session && this.userMessageQueue) {
        await this.session.processQueue(this.userMessageQueue);
      }
    });

    // Subscribe to turn_finished for state update and next message processing
    this.on(ClaudeCodeConnectorSubjects.turn.turn_finished, async () => {
      await this.updateProcessingState('turn_finished');
      // Note: message_completed is NOT a processing state - it's signaled via MessageHandle.markCompleted()
      await this.updateProcessingState('processing_finished');

      if (this.hasPendingToolRefresh) {
        await this.refreshMcpServers();
        this.hasPendingToolRefresh = false;
      }

      // Process next queued message or go idle
      if (this.session && this.userMessageQueue && !this.userMessageQueue.isEmpty()) {
        await this.session.processQueue(this.userMessageQueue);
      } else {
        // No more messages - transition to idle
        await this.updateProcessingState('idle');
      }
    });
  }

  /**
   * Signal that MCP tool definitions have changed and the server list should be
   * refreshed at the end of the current turn.
   *
   * The refresh is deferred to `turn_finished` so it does not interrupt an
   * in-flight tool call sequence. Calling this multiple times before the next
   * turn boundary is idempotent — the refresh runs exactly once.
   */
  public override markToolRefreshPending(): void {
    this.hasPendingToolRefresh = true;
  }

  /**
   * Resolve the latest MCP server list for this session and push it to the
   * live SDK query instance so subsequent tool calls see the updated definitions.
   *
   * Fails gracefully: if the bus request cannot be fulfilled (no handler, network
   * error, etc.) the error is logged and the existing server configuration is
   * left unchanged rather than breaking the connector.
   */
  private async refreshMcpServers(): Promise<void> {
    const mcpSessionContext = this.config.mcpSessionContext;
    if (!this.session || !hasMcpResolutionScope(mcpSessionContext)) {
      return;
    }

    try {
      const resolved = await MakaioBus.request(McpSubjects.session.resolve, {
        sessionId: mcpSessionContext.sessionId,
        projectId: mcpSessionContext.projectId,
        profileId: mcpSessionContext.profileId,
      });
      await this.session.updateMcpServers(resolved.servers);
    } catch (error) {
      console.error('[ClaudeSdkConnector] MCP server refresh failed, keeping existing config:', error);
    }
  }

  /**
   * Emit the current Claude account snapshot after a successfully completed turn.
   * @param result - Turn result produced by the session lifecycle
   */
  private async emitCompletedTurnAccountObservation(result: MessageResult): Promise<void> {
    if (result.outcome !== 'completed') {
      return;
    }

    await this.accountObservationEmitter.emitIfChanged({
      sessionId: this.sessionId,
      adapterSessionId: this.adapterSessionId,
      getQueryInstance: () => this.session?.getQueryInstance(),
    });
  }

  /**
   * Create the tool approval handler for SDK query options.
   * Extracted to allow reuse when creating new query instances.
   * @returns The canUseTool callback function for SDK query options
   */
  private createToolApprovalHandler(): Options['canUseTool'] {
    return async (toolName, input, options) => {
      // Request approval via scoped bus (agent.ts wires to global AgentSubjects.toolApprove)
      const response = await this.requestToolApproval(ClaudeCodeConnectorSubjects.can_use_tool, {
        toolName,
        args: input,
        toolCallId: options.toolUseID,
        reasoning: this.session?.getAccumulatedThinking(),
      }).catch((error) => {
        let errorToHandle = error;
        if (error instanceof RequestError || error instanceof NoHandlerError) {
          errorToHandle = new Error(
            "Tool approval request failed, make sure that there's a handler registered: " + error.message,
          );
        }
        // Don't terminate - let agent try alternative approaches without tools
        this.handleError(errorToHandle, false);
        throw error;
      });

      // Map core schema to Claude SDK's PermissionResult
      if (response.action === 'allow') {
        // Record mcp_call invocations in the session tool ledger after a successful
        // approval. Uses post-approval args so that when an approval handler rewrites
        // the `tool` field the ledger records the target the model actually called.
        if (this.config.toolLedger && isMcpCallTool(toolName)) {
          const approvedArgs = (response.updatedInput as Record<string, unknown> | undefined) ?? input;
          const targetTool = extractMcpCallTarget(approvedArgs);
          if (targetTool !== undefined) {
            this.config.toolLedger.recordCall(targetTool, this.currentTurnNumber);
          }
        }

        return {
          behavior: 'allow',
          updatedInput: response.updatedInput ?? input,
          // Cast unknown[] to PermissionUpdate[] - core schema uses unknown for flexibility
          updatedPermissions: response.updatedPermissions as PermissionUpdate[] | undefined,
        } satisfies PermissionResult;
      } else {
        // For abort decision, mark error SYNCHRONOUSLY before returning to SDK.
        // This prevents race where SDK sends result and marks message as 'completed'
        // before any deferred error handler runs.
        if (response.shouldAbort) {
          this.handleError(new Error(`Tool use denied by approval handler: ${toolName}`), false);
        }

        return {
          behavior: 'deny',
          message: response.message,
          interrupt: response.shouldAbort ?? false,
        } satisfies PermissionResult;
      }
    };
  }

  /**
   * Get session ID, waiting for SDK to generate it if not yet available.
   * Delegates to Session for session ID management.
   * @returns The session ID
   */
  public async getAdapterSessionId(): Promise<string> {
    if (!this.session) {
      throw new Error('Session not initialized. Call start() first.');
    }
    this.adapterSessionId = await this.session.getAdapterSessionId();
    return this.adapterSessionId;
  }

  /**
   * Create and enqueue an initial message, initializing the session if needed.
   * @param message - The user message to send
   * @param options - Message options including delivery mode and message history
   * @returns Object containing the message handle
   */
  private async createInitialMessage(message: NormalizedMessageInput, options?: ConnectorSendMessageOptions) {
    if (!this.session) {
      await this.initializeSession(options?.responseSchema);
    }

    // Create message handle and enqueue
    const handle = this.createMessageHandle(message, options);
    this.userMessageQueue!.enqueue(handle);

    // Trigger active state transition when starting from idle/paused
    if (this.getProcessingState() === 'idle' || this.getProcessingState() === 'paused') {
      await this.updateProcessingState('active');
    }

    return {
      handle,
    };
  }

  /**
   * Initialize the connector's SDK session without sending a message.
   * Must set adapterSessionId before returning.
   * Called by createAgent for idle agent setup.
   * Implementations MUST be idempotent (no-op if already initialized).
   * @param options - Optional start options (e.g., systemPrompt for Claude)
   */
  public async initialize(options?: ConnectorStartOptions): Promise<void> {
    if (this.session) return; // Idempotent
    if (options?.systemPrompt && !this.runtimeSystemPrompt) {
      this.runtimeSystemPrompt = options.systemPrompt;
    }
    await this.initializeSession(options?.responseSchema);
    this.adapterSessionId = await this.session!.getAdapterSessionId();
  }

  /**
   * Return the provider-confirmed session ID from the underlying Claude session.
   *
   * Returns `undefined` for idle fork sessions until `system.init` arrives,
   * allowing upstream persistence to defer writing the adapter session ID.
   * @returns Confirmed adapter session ID or `undefined`
   */
  public override getConfirmedAdapterSessionId(): string | undefined {
    return this.session?.getConfirmedSessionId();
  }

  /**
   * Report the rotation this connector would perform if the next dispatch
   * declined native resume.
   *
   * Required override: for a non-fork session
   * {@link getConfirmedAdapterSessionId} reports the locally seeded resume ID —
   * the provider will adopt it, so it is authoritative — but the session drops
   * exactly that target and rotates to a fresh query while `system.init` is
   * still outstanding. Left to the base `false`, the movement seam would see an
   * ID and conclude nothing moved, leaving the session row pointing at the
   * abandoned provider thread.
   * @returns `true` while an unconfirmed resume target is armed
   */
  public override movesProviderSessionOnSuppressedResume(): boolean {
    return this.session?.resumeTargetPendingSuppression() !== undefined;
  }

  /**
   * Start session with initial message.
   * Initializes Session/Turn and sends the initial message via queue.
   * @param message - The initial user message (SDKUserMessage or MessageParam)
   * @param options - Message options including delivery mode
   * @returns The agent ID, session ID and message handle
   */
  public async start(
    message: NormalizedMessageInput,
    options?: ConnectorStartOptions | undefined,
  ): Promise<AgentStartResult> {
    // Capture systemPrompt from options (session-level, set once on first call)
    if (options?.systemPrompt && !this.runtimeSystemPrompt) {
      this.runtimeSystemPrompt = options.systemPrompt;
    }

    const { handle } = await this.createInitialMessage(message, options);

    // Process queue - Session will start new turn
    await this.session!.processQueue(this.userMessageQueue!);

    // Get session ID from Session
    const sessionId = await this.session!.getAdapterSessionId();
    this.adapterSessionId = sessionId;

    // Set adapterSessionId on handle for callers
    handle.adapterSessionId = sessionId;

    return { agentId: this.agentId, adapterSessionId: sessionId, messageHandle: handle };
  }

  /**
   * Abort the session and cleanup resources (panic mode).
   * Triggers AbortController which causes SDK to throw.
   * Use close() for graceful shutdown instead.
   *
   * NOTE: Session closed events are emitted by the AIAgent layer (ClaudeCodeAgent),
   * not here in the connector.
   */
  public abort(): void {
    if (this.session) {
      this.session.abort().catch((error) => {
        console.error('Session abort failed:', error);
      });
    }
  }

  /**
   * Gracefully close the session.
   * Unlike abort(), this doesn't cause SDK errors.
   * Use this for normal shutdown; use abort() for emergency termination.
   */
  public async close(): Promise<void> {
    if (this.session) {
      await this.session.close();
    }
  }

  /**
   * Change the reasoning effort level without a connector swap.
   *
   * Applies the new budget via `setMaxThinkingTokens` on the live SDK query instance.
   * Passing `null` (for `'none'`) disables extended thinking in-place.
   * Returns `false` when no session/query is available so the caller can fall back
   * to a connector swap.
   *
   * **Mutation contract:** Does NOT mutate `this.currentReasoningEffort`. The caller
   * ({@link AgentRuntimeMutationManager}) owns that field update after this returns `true`.
   * @param newLevel - The new reasoning effort level to apply
   * @returns `true` if applied in-place, `false` if a connector swap is needed
   */
  public override async changeReasoningInPlace(newLevel: AIReasoningLevel): Promise<boolean> {
    if (!this.session) return false;
    const queryInstance = this.session.getQueryInstance();
    if (!queryInstance) return false;

    try {
      const tokens = newLevel === 'none' ? null : parseReasoningLevel(newLevel);
      await queryInstance.setMaxThinkingTokens(tokens);
      // Keep the session config in sync so query rotations (immediate-mode) build
      // the new query with the updated effort rather than the stale initial value.
      this.session.updateReasoningEffort(newLevel === 'none' ? undefined : newLevel);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Change model via the Claude SDK query control API.
   * Falls back to connector swap if no active session/query.
   * @param newModel - The model identifier to switch to
   * @returns true if model changed in-place, false if swap needed
   */
  public override async changeModelInPlace(newModel: string): Promise<boolean> {
    if (!this.session) return false;
    const queryInstance = this.session.getQueryInstance();
    if (!queryInstance) return false;

    try {
      await queryInstance.setModel(newModel);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Interrupt the current message processing.
   * Delegates to Session for interrupt handling.
   */
  public async interrupt(): Promise<void> {
    if (this.session) {
      await this.session.interrupt();
    }
  }

  /**
   * Complete the agent session by waiting for all messages to finish.
   * @returns Last message result or null if no messages processed
   */
  public async complete(): Promise<MessageResult | null> {
    // Wait for agent to reach terminal state (idle or paused)
    while (this.getProcessingState() !== 'idle' && this.getProcessingState() !== 'paused') {
      await this.onceProcessingStateChanged();
    }
    return this.lastResult;
  }

  /**
   * Send user message with delivery mode control.
   * Enqueues message and delegates to Session for processing.
   * @param message - The user message (SDKUserMessage or MessageParam)
   * @param options - Message options including delivery mode
   * @returns MessageHandle for tracking and cancellation
   */
  public async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    const { handle } = await this.createInitialMessage(message, options);

    // Process queue FIRST - Session handles turn creation and sends to SDK
    // Must happen before getAdapterSessionId() which waits for system.init event
    await this.session!.processQueue(this.userMessageQueue!);

    // Get session ID and set on handle (now safe - SDK will have sent system.init)
    const sessionId = await this.session!.getAdapterSessionId();
    handle.adapterSessionId = sessionId;
    this.adapterSessionId = sessionId;

    return handle;
  }
}
