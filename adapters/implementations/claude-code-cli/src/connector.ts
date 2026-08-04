import {
  AIAgentConnector,
  type AIReasoningLevel,
  type NormalizedMessageInput,
  type AgentStartResult,
  type MessageResult,
  type ConnectorSendMessageOptions,
  type ConnectorStartOptions,
  type MessageHandle,
  UserMessageQueue,
} from '@makaio/ai-adapters-core';
import { readClaudeProviderBaseUrl, resolveClaudeProcessEnv } from '@makaio/ai-adapters-claude-process-shared';
import { type ClaudeCodeCliConnectorBus, ClaudeCodeCliConnectorSubjects } from './namespace/index.js';
import { ClaudeCliSession } from './session.js';
import { ClaudeCodeCliAdapterName } from './constants.js';
import type { ClaudeCliAgentConfig, ClaudeCliSessionConfig } from './types.js';

const SDK_METADATA_KEYS = ['agentId', 'adapterId', 'adapterSessionId', 'adapterName'] as const;

/**
 * Remove connector-managed metadata keys so `emit()` can inject canonical values.
 * @param payload - Raw SDK event payload received from the provider.
 * @returns SDK payload without connector-managed metadata fields, or undefined for non-object payloads
 */
function stripSdkMetadata(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const sanitized: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const key of SDK_METADATA_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

/**
 * Compare system prompt values across initialize/start calls.
 * @param previous - Previously captured prompt
 * @param next - Newly captured prompt
 * @returns True when prompt values are equivalent
 */
function isSameSystemPrompt(
  previous: ConnectorStartOptions['systemPrompt'],
  next: ConnectorStartOptions['systemPrompt'],
): boolean {
  if (previous === next) return true;
  if (typeof previous === 'string' || typeof next === 'string') return previous === next;
  if (previous === undefined || next === undefined) return previous === next;
  return previous.mode === next.mode && previous.content === next.content;
}

/**
 * Connector for the Claude Code CLI adapter.
 *
 * Manages the lifecycle of `claude -p` subprocess invocations.
 * Each turn spawns a fresh CLI process; multi-turn context is preserved
 * server-side via `--session-id`/`--resume`.
 *
 * Unlike the SDK adapter there is no persistent query object — the
 * session owns the subprocess and is recreated on each call to
 * `processQueue()`.
 */
export class ClaudeCliConnector extends AIAgentConnector<ClaudeCodeCliConnectorBus> {
  private session?: ClaudeCliSession;
  private userMessageQueue?: UserMessageQueue;
  private turnEventsWired = false;

  /**
   * Create a Claude CLI connector bound to one agent instance.
   * @param config - Connector configuration including adapter identity and optional `adapterName`.
   * When `adapterName` is omitted, it defaults to `ClaudeCodeCliAdapterName`.
   */
  public constructor(config: ClaudeCliAgentConfig) {
    super({
      ...config,
      adapterId: config.adapterId,
      adapterName: config?.adapterName ?? ClaudeCodeCliAdapterName,
    });
  }

  // ============================================================================
  // Session initialisation
  // ============================================================================

  /**
   * Initialize the session object (no subprocess yet).
   * Called on first start() or initialize().
   */
  private async initializeSession(): Promise<void> {
    const cliConfig = this.config as ClaudeCliAgentConfig;
    const env = resolveClaudeProcessEnv({
      spawnEnv: this.env,
      baseUrl: readClaudeProviderBaseUrl(cliConfig.providerConfig),
    });
    const binaryPath = cliConfig.clientExecution?.binaryPath ?? undefined;

    const sessionConfig: ClaudeCliSessionConfig = {
      bus: this.config.bus as ClaudeCodeCliConnectorBus,
      adapterId: this.adapterId,
      adapterName: this.adapterName,
      agentId: this.agentId,
      cwd: this.cwd,
      model: this.model,
      env,
      contextEnv: cliConfig.contextEnv ?? {},
      providerConfig: cliConfig.providerConfig,
      reasoningEffort: this.currentReasoningEffort,
      allowedTools: cliConfig.allowedTools,
      disallowedTools: cliConfig.disallowedTools,
      binaryPath,
      firstOutputTimeoutMs: this.timeouts.values.initialization,
      resumeAdapterSessionId: this.config.resumeAdapterSessionId,
      nativeFork: cliConfig.nativeFork,
      predeterminedSessionId: this.config.adapterSessionId,
      mcpUpstreamServers: cliConfig.mcpUpstreamServers,
      makaioSessionId: this.sessionId,
      systemPrompt: this.systemPrompt,
      emitSdkEvent: async (msg) => {
        this.logLowLevelEvent(msg);
        // Sync adapterSessionId before emitting
        if (this.session) {
          const currentId = await this.session.getAdapterSessionId();
          if (currentId !== this.adapterSessionId) {
            this.adapterSessionId = currentId;
          }
        }
        // Keep sdk.event raw while letting AIAgentConnector inject canonical adapter metadata.
        const sdkEventPayload = stripSdkMetadata(msg);
        if (!sdkEventPayload) {
          console.warn('[ClaudeCliConnector] Dropping non-object SDK event payload', { payloadType: typeof msg });
          return;
        }
        await this.emit(ClaudeCodeCliConnectorSubjects.sdk.event, {
          ...sdkEventPayload,
          ...(this.pendingMessageHandle !== undefined && { originatingMessageId: this.pendingMessageHandle.messageId }),
        } as Parameters<typeof this.emit<typeof ClaudeCodeCliConnectorSubjects.sdk.event>>[1]);
      },
      onTurnStart: (handle) => {
        this.pendingMessageHandle = handle;
      },
      onTurnComplete: (_handle, result) => {
        this.lastResult = result;
        this.pendingMessageHandle = undefined;
      },
      // Movement seam sink for the one rotation the executor cannot predict:
      // an immediate-mode restart supersedes the live subprocess and mints a
      // fresh identity, and only the session knows the supersede actually won.
      ...(this.config.onAdapterSessionMoved !== undefined && {
        onAdapterSessionMoved: this.config.onAdapterSessionMoved,
      }),
    };

    this.session = new ClaudeCliSession(sessionConfig);
    this.userMessageQueue = new UserMessageQueue();

    await this.session.initialize();
    this.wireSessionEvents();
  }

  /**
   * Wire turn lifecycle events from the scoped bus to connector state updates.
   */
  private wireSessionEvents(): void {
    if (this.turnEventsWired) return;
    this.turnEventsWired = true;

    this.on(ClaudeCodeCliConnectorSubjects.turn.turn_started, async () => {
      await this.updateProcessingState('turn_started');
    });

    this.on(ClaudeCodeCliConnectorSubjects.turn.step_started, async () => {
      await this.updateProcessingState('step_started');
    });

    this.on(ClaudeCodeCliConnectorSubjects.turn.step_finished, async () => {
      await this.updateProcessingState('step_finished');
      // Process queue at step_finished to detect immediate messages while turn is active
      if (this.session && this.userMessageQueue) {
        await this.processQueue();
      }
    });

    this.on(ClaudeCodeCliConnectorSubjects.turn.turn_finished, async () => {
      await this.updateProcessingState('turn_finished');
      await this.updateProcessingState('processing_finished');

      const turnStarted = await this.processQueue();
      if (!turnStarted) {
        await this.updateProcessingState('idle');
      }
    });
  }

  // ============================================================================
  // Queue processing
  // ============================================================================

  /**
   * Process the message queue via the shared processQueueMessages orchestration.
   *
   * Delegates to session.processQueue() which handles immediate-mode superseding,
   * late rejection, and normal enqueue processing.
   *
   * Returns `true` when a new turn was started, `false` when no turn was started
   * (e.g., the queue was empty or all immediate messages were rejected).
   * @returns True if a new turn was started
   */
  private async processQueue(): Promise<boolean> {
    if (!this.userMessageQueue || !this.session) return false;
    return this.session.processQueue(this.userMessageQueue);
  }

  /**
   * Reset the current session when systemPrompt changes between calls.
   * Logs discarded queued messages to avoid silent drops.
   * @param options - Initialize/start options containing a potential systemPrompt update
   */
  private async resetSessionIfSystemPromptChanged(options?: ConnectorStartOptions): Promise<void> {
    const previousSystemPrompt = this.systemPrompt;
    this.captureSystemPrompt(options?.systemPrompt);
    if (
      !this.session ||
      options?.systemPrompt === undefined ||
      isSameSystemPrompt(previousSystemPrompt, this.systemPrompt)
    ) {
      return;
    }

    const pendingMessages = this.userMessageQueue?.size() ?? 0;
    if (pendingMessages > 0) {
      console.warn(
        `[claude-code-cli] Discarding ${pendingMessages} queued message(s) while resetting session due to systemPrompt change.`,
        { previousSystemPrompt },
      );
    }

    await this.session.close();
    this.session = undefined;
    this.userMessageQueue = undefined;
  }

  // ============================================================================
  // AIAgentConnector interface
  // ============================================================================

  /**
   * Initialize the connector without sending a message.
   * Idempotent — no-op if already initialized.
   * @param options - Optional start options; captures `systemPrompt` for CLI flag injection
   */
  public async initialize(options?: ConnectorStartOptions): Promise<void> {
    await this.resetSessionIfSystemPromptChanged(options);
    if (this.session) return;
    await this.initializeSession();
    this.adapterSessionId = await this.session!.getAdapterSessionId();
  }

  /**
   * Return the provider-confirmed session ID from the underlying Claude CLI session.
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
   * exactly that target and mints a fresh identity while `system.init` is still
   * outstanding. Left to the base `false`, the movement seam would see an ID and
   * conclude nothing moved, leaving the session row pointing at the abandoned
   * provider thread.
   * @returns `true` while an unconfirmed resume target is armed
   */
  public override movesProviderSessionOnSuppressedResume(): boolean {
    return this.session?.resumeTargetPendingSuppression() !== undefined;
  }

  /**
   * Start the connector with an initial user message.
   * @param message - The first user message
   * @param options - Optional start options
   * @returns Agent start result with session ID and message handle
   */
  public async start(message: NormalizedMessageInput, options?: ConnectorStartOptions): Promise<AgentStartResult> {
    await this.resetSessionIfSystemPromptChanged(options);
    if (!this.session) {
      await this.initializeSession();
    }

    const handle = this.createMessageHandle(message, options);
    this.userMessageQueue!.enqueue(handle);

    await this.updateProcessingState('active');
    const turnStarted = await this.processQueue();
    if (!turnStarted) {
      // Queue processing can reject immediate messages without starting a turn.
      await this.updateProcessingState('idle');
    }

    const sessionId = await this.session!.getAdapterSessionId();
    this.adapterSessionId = sessionId;
    handle.adapterSessionId = sessionId;

    return { agentId: this.agentId, adapterSessionId: sessionId, messageHandle: handle };
  }

  /**
   * Send a follow-up user message.
   * @param message - The user message
   * @param options - Optional delivery mode options
   * @returns MessageHandle for tracking
   */
  public async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    if (!this.session) {
      await this.initializeSession();
    }

    const handle = this.createMessageHandle(message, options);
    this.userMessageQueue!.enqueue(handle);

    if (this.getProcessingState() === 'idle' || this.getProcessingState() === 'paused') {
      await this.updateProcessingState('active');
      const turnStarted = await this.processQueue();
      if (!turnStarted) {
        // No turn was started (e.g., immediate arrived too late and was rejected).
        // Return to idle so complete() can resolve.
        await this.updateProcessingState('idle');
      }
    }

    const sessionId = await this.session!.getAdapterSessionId();
    handle.adapterSessionId = sessionId;
    this.adapterSessionId = sessionId;

    return handle;
  }

  /**
   * Get the adapter session ID.
   * @returns Promise resolving to the session ID
   */
  public async getAdapterSessionId(): Promise<string> {
    if (!this.session) {
      throw new Error('Session not initialized. Call start() first.');
    }
    this.adapterSessionId = await this.session.getAdapterSessionId();
    return this.adapterSessionId;
  }

  /**
   * Abort the session by killing the subprocess.
   */
  public abort(): void {
    this.session?.abort().catch((error) => {
      console.error('Session abort failed:', error);
    });
  }

  /**
   * Gracefully close the session.
   */
  public async close(): Promise<void> {
    if (this.session) {
      await this.session.close();
    }
  }

  /**
   * Wait for all messages to finish processing.
   * @returns Last message result or null
   */
  public async complete(): Promise<MessageResult | null> {
    while (this.getProcessingState() !== 'idle' && this.getProcessingState() !== 'paused') {
      await this.onceProcessingStateChanged();
    }
    return this.lastResult;
  }

  /**
   * The CLI spawns a fresh process per turn — model can always be changed in-place.
   * @param _newModel - The new model identifier (applied on next turn start)
   * @returns Always true — model is read at turn spawn time
   */
  public override async changeModelInPlace(_newModel: string): Promise<boolean> {
    return true;
  }

  /**
   * The CLI is stateless per-turn — reasoning effort is passed via `--effort` on each spawn.
   *
   * Propagates the new level to the active session so the next `startTurn` call
   * picks it up without requiring a session teardown.
   *
   * **Mutation contract:** The caller (`AgentRuntimeMutationManager`) owns the
   * `currentReasoningEffort` field update; this method must not mutate it directly.
   * @param newLevel - The new reasoning effort level (applied on next turn spawn)
   * @returns Always `true` — effort is injected at spawn time, no swap needed
   */
  public override async changeReasoningInPlace(newLevel: AIReasoningLevel): Promise<boolean> {
    this.session?.setReasoningEffort(newLevel);
    return true;
  }

  /**
   * Interrupt is not supported for the CLI adapter (single-shot process).
   * Killing the process would also discard any accumulated context.
   */
  public async interrupt(): Promise<void> {
    throw new Error('Claude Code CLI adapter does not support interrupt()');
  }
}
