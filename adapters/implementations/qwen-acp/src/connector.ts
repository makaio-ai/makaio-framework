// NOTE: do NOT change the eslint override on the next line without explicit human approval
/* eslint max-lines: ["error", { "max": 670 }] */
import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  AIAgentConnector,
  UserMessageQueue,
  markCompletedWithFinalResult,
  processQueueMessages,
  type NormalizedMessageInput,
  type AgentStartResult,
  type MessageResult,
  type ConnectorSendMessageOptions,
  type ConnectorStartOptions,
  type MessageHandle,
} from '@makaio/ai-adapters-core';
import { createAcpConnection, MakaioAcpClient, TerminalManager } from '@makaio/ai-adapters-acp-client';
import type { AcpConnectionHandle } from '@makaio/ai-adapters-acp-client';
import { QwenAcpTurn } from './turn.js';
import { QwenAcpSubjects } from './namespaces/index.js';
import type { QwenAcpBus } from './namespaces/index.js';
import { mapApprovalToAcpResponse } from './permission.js';
import { QwenAcpProviderConfigSchema } from './schemas.js';
import { getSystemPromptText, shouldReinitializeSystemPrompt } from './system-prompt.js';
import { executeAcpReadTextFile, executeAcpWriteTextFile } from './tool-execution.js';
import { buildCliArgs } from './utils/build-cli-args.js';
import { buildPromptContent } from './utils/build-prompt.js';
import { toAcpMcpServers } from './utils/mcp-servers.js';
import type { QwenAcpConnectorConfig } from './types.js';
import { assertQwenNativeAuth } from './native-auth.js';
import { QWEN_ACP_AUTH_SCRUB_ENV_VARS } from './provider.js';

/** Pending entry for a `getAdapterSessionId()` caller waiting for session establishment. */
type SessionIdWaiter = {
  resolve: (id: string) => void;
  reject: (err: Error) => void;
  interval: ReturnType<typeof setInterval>;
};

/**
 * Accumulated token usage for the current turn.
 *
 * Qwen ACP sends running totals in every `agent_message_chunk._meta.usage`.
 * We keep the last-seen non-undefined value for each field (last-wins semantics)
 * and emit a single consolidated event at turn-end.
 */
type TurnUsageAccumulator = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
};

/** Connector for the Qwen ACP adapter. Turn finalization MUST remain in `finally`. */
export class QwenAcpConnector extends AIAgentConnector<QwenAcpBus> {
  private acpConnectionHandle?: AcpConnectionHandle;
  private acpSessionId?: string;
  private currentTurn?: QwenAcpTurn;
  private readonly messageQueue = new UserMessageQueue();
  private isInitialized = false;
  private isTerminated = false;
  private initializingPromise?: Promise<void>;
  private systemPromptTempFile?: string;
  private readonly terminalManager: TerminalManager;
  /** toolCallId from the most recent tool_call session update, used to correlate filesystem callbacks. */
  private lastToolCallId?: string;
  private readonly toolCallMessageIds = new Map<string, string>();

  /** Per-turn, last-wins usage totals; null when no active turn has reported usage. */
  private turnUsageAccumulator: TurnUsageAccumulator | null = null;

  /** Pending `getAdapterSessionId()` waiters — cleared on termination to prevent interval leaks. */
  private sessionIdWaiters: SessionIdWaiter[] = [];

  /**
   * Create a new QwenAcpConnector instance.
   * @param config - Full connector configuration with adapterId from the config factory
   */
  public constructor(config: QwenAcpConnectorConfig) {
    const { adapterAuth, ...baseConfig } = config;
    assertQwenNativeAuth(adapterAuth);
    super({ ...baseConfig, env: baseConfig.env ?? {} });
    this.terminalManager = new TerminalManager({
      baseEnv: this.env,
      scrubEnvVars: QWEN_ACP_AUTH_SCRUB_ENV_VARS,
    });
  }

  /**
   * Initialize the ACP session without sending a message. Idempotent.
   * @param options - Optional start options; captures system prompt for injection
   * @returns Resolves after the ACP session is ready
   */
  public async initialize(options?: ConnectorStartOptions): Promise<void> {
    if (this.isTerminated) throw new Error('QwenAcpConnector has already been terminated');
    if (this.shouldReinitializeForSystemPrompt(options?.systemPrompt)) await this.resetConnection();
    this.captureSystemPrompt(options?.systemPrompt);
    if (this.isInitialized) return;
    this.initializingPromise ??= this.initializeConnection()
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.rejectSessionIdWaiters(err);
        throw err;
      })
      .finally(() => {
        this.initializingPromise = undefined;
      });
    await this.initializingPromise;
    if (this.needsLateSystemPromptRebuild(options?.systemPrompt)) {
      await this.resetConnection();
      await this.initialize(options);
    }
  }

  /**
   * Start the connector with an initial user message.
   * @param message - Normalized user message
   * @param options - Optional start options
   * @returns Session ID, agent ID, and message handle
   */
  public async start(message: NormalizedMessageInput, options?: ConnectorStartOptions): Promise<AgentStartResult> {
    await this.initialize(options);
    const messageHandle = await this.sendMessage(message, options);
    return { adapterSessionId: this.acpSessionId!, agentId: this.agentId, messageHandle };
  }

  /**
   * Enqueue a user message and trigger queue processing when idle.
   * @param message - Normalized user message
   * @param options - Optional delivery mode options
   * @returns Message handle for tracking acknowledgment and completion
   */
  public async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    if (!this.isInitialized) await this.initialize();
    const handle = this.createMessageHandle(message, options);
    if (this.getProcessingState() === 'idle') await this.updateProcessingState('active');
    this.messageQueue.enqueue(handle);
    await this.processQueue();
    return handle;
  }

  /** Interrupt the current turn via ACP `session/cancel` (best-effort). */
  public async interrupt(): Promise<void> {
    if (!this.acpConnectionHandle || !this.acpSessionId) return;
    try {
      await this.acpConnectionHandle.connection.cancel({ sessionId: this.acpSessionId });
    } catch {
      // best-effort
    }
  }

  /** Abort the connector immediately (panic mode). Kills subprocess. */
  public abort(): void {
    if (this.isTerminated) return;
    this.isTerminated = true;
    this.clearConnectionState();
    if (this.currentTurn) this.currentTurn.markCompleted({ outcome: 'cancelled' });
    this.drainSessionIdWaiters();
    void this.cleanupSystemPromptTempFile();
  }

  /** Gracefully shut down: cancel then kill. */
  public async close(): Promise<void> {
    if (this.isTerminated) return;
    this.isTerminated = true;
    this.drainSessionIdWaiters();
    if (this.acpConnectionHandle && this.acpSessionId) {
      try {
        await Promise.race([
          this.acpConnectionHandle.connection.cancel({ sessionId: this.acpSessionId }),
          new Promise<void>((r) => setTimeout(r, 2_000)),
        ]);
      } catch {
        // ignore
      }
    }
    this.clearConnectionState();
    await this.cleanupSystemPromptTempFile();
  }

  private drainSessionIdWaiters(): void {
    this.rejectSessionIdWaiters(new Error('Connector terminated before session ID was established'));
  }
  private rejectSessionIdWaiters(err: Error): void {
    for (const w of this.sessionIdWaiters) {
      clearInterval(w.interval);
      w.reject(err);
    }
    this.sessionIdWaiters = [];
  }

  private async cleanupSystemPromptTempFile(): Promise<void> {
    if (!this.systemPromptTempFile) return;
    const path = this.systemPromptTempFile;
    this.systemPromptTempFile = undefined;
    await this.cleanupTempFile(path);
  }

  /**
   * Get the ACP session ID, rejecting if the connector terminates first.
   * @returns Resolved ACP session ID
   */
  public getAdapterSessionId(): Promise<string> {
    if (this.acpSessionId) return Promise.resolve(this.acpSessionId);
    if (this.isTerminated) return Promise.reject(new Error('Connector terminated before session ID was established'));
    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (this.acpSessionId) {
          clearInterval(interval);
          this.sessionIdWaiters = this.sessionIdWaiters.filter((w) => w.interval !== interval);
          resolve(this.acpSessionId);
        }
      }, 50);
      this.sessionIdWaiters.push({ resolve, reject, interval });
    });
  }

  /**
   * Wait for all queued messages to finish processing.
   * @returns Final message result or `null`
   */
  public async complete(): Promise<MessageResult | null> {
    while (this.getProcessingState() !== 'idle' && this.getProcessingState() !== 'paused') {
      await this.onceProcessingStateChanged();
    }
    return this.lastResult;
  }

  /**
   * Model is bound at subprocess spawn time; in-place change is not supported.
   * @param _newModel - Ignored; model must be set before spawn
   * @returns Always `false` — a connector swap is required
   */
  public override async changeModelInPlace(_newModel: string): Promise<boolean> {
    return false;
  }

  /**
   * Working directory is bound at subprocess spawn time; in-place change is not supported.
   * @param _newCwd - Ignored; cwd must be set before spawn
   * @returns Always `false` — a connector swap is required
   */
  public override async changeCwdInPlace(_newCwd: string): Promise<boolean> {
    return false;
  }

  private async initializeConnection(): Promise<void> {
    const providerConfig = this.config.providerConfig
      ? QwenAcpProviderConfigSchema.parse(this.config.providerConfig)
      : undefined;
    const client = new MakaioAcpClient({
      onSessionUpdate: (n: SessionNotification) => this.onSessionUpdate(n),
      onRequestPermission: (p: RequestPermissionRequest) => this.onRequestPermission(p),
      onReadTextFile: (p: ReadTextFileRequest) => this.onReadTextFile(p),
      onWriteTextFile: (p: WriteTextFileRequest) => this.onWriteTextFile(p),
      terminalManager: this.terminalManager,
    });

    // Capture systemPrompt synchronously before any await so that a concurrent
    // initialize() call that sets this.systemPrompt cannot race this initialization.
    const capturedSystemPrompt = this.systemPrompt;

    const spawnEnv = { ...this.env };
    const command = this.config.clientExecution?.binaryPath ?? 'qwen';
    const tempPath = capturedSystemPrompt ? await this.createSystemPromptTempFile(capturedSystemPrompt) : undefined;
    if (tempPath) spawnEnv['QWEN_SYSTEM_MD'] = tempPath;

    const args = buildCliArgs({ model: this.model, providerConfig });
    let handle: AcpConnectionHandle | undefined;
    try {
      handle = await createAcpConnection(() => client, {
        command,
        args,
        cwd: this.cwd,
        env: spawnEnv,
        onStderr: (data: string) => console.error(`[qwen-acp stderr] ${data}`),
        onError: (error: Error) => console.error('[qwen-acp spawn error]', error),
        onExit: (code: number | null) => {
          if (!this.isTerminated) this.handleError(new Error(`Qwen ACP exited: ${String(code)}`), true);
        },
      });

      await handle.connection.initialize({
        clientInfo: { name: 'makaio', version: '0.1.0' },
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
      });
      // Thread upstream MCP servers from the session context into the ACP session.
      // Only the full McpSessionContext carries `servers`; narrow via property check.
      const mcpCtx = (this.config as QwenAcpConnectorConfig).mcpSessionContext;
      const mcpServers = toAcpMcpServers(mcpCtx && 'servers' in mcpCtx ? mcpCtx.servers : undefined);
      const session = await handle.connection.newSession({ cwd: this.cwd, mcpServers });

      this.acpConnectionHandle = handle;
      this.systemPromptTempFile = tempPath;
      this.acpSessionId = session.sessionId;
      this.adapterSessionId = this.acpSessionId;
      this.isInitialized = true;
    } catch (error) {
      handle?.kill();
      await this.cleanupTempFile(tempPath);
      throw error;
    }
  }

  private shouldReinitializeForSystemPrompt(nextPrompt: ConnectorStartOptions['systemPrompt']): boolean {
    return shouldReinitializeSystemPrompt({
      isInitialized: this.isInitialized,
      nextPrompt,
      currentPrompt: this.systemPrompt,
      hasActiveTurn: this.currentTurn !== undefined,
      hasPendingMessage: this.pendingMessageHandle !== undefined,
      hasCompletedTurn: this.lastResult !== null,
      processingState: this.getProcessingState(),
    });
  }

  private needsLateSystemPromptRebuild(nextPrompt: ConnectorStartOptions['systemPrompt']): boolean {
    return (
      nextPrompt !== undefined &&
      this.isInitialized &&
      this.systemPromptTempFile === undefined &&
      this.currentTurn === undefined &&
      this.pendingMessageHandle === undefined &&
      this.lastResult === null &&
      this.getProcessingState() === 'idle'
    );
  }

  private async resetConnection(): Promise<void> {
    this.clearConnectionState();
    this.drainSessionIdWaiters();
    await this.cleanupSystemPromptTempFile();
  }

  private async processQueue(): Promise<boolean> {
    return processQueueMessages(this.messageQueue, {
      getCurrentTurn: () => this.currentTurn,
      startNewTurn: (handle, mergedContent) => this.startTurn(handle, mergedContent),
    });
  }

  private async startTurn(handle: MessageHandle, mergedContent?: string[]): Promise<void> {
    const connection = this.acpConnectionHandle;
    const sessionId = this.acpSessionId;
    if (!connection || !sessionId) throw new Error('Qwen ACP session is not initialized');
    const turn = new QwenAcpTurn(handle, this.config.bus as QwenAcpBus, this.adapterId, this.adapterName, this.agentId);
    this.currentTurn = turn;
    this.turnUsageAccumulator = {};
    this.pendingMessageHandle = handle;
    handle.adapterSessionId = sessionId;
    handle.markAcknowledged();
    await turn.start();
    await this.updateProcessingState('turn_started');
    const prompt = buildPromptContent(handle.message, handle.messageHistory, handle.turnContext, mergedContent);
    queueMicrotask(() => void this.runPromptTurn(turn, handle, prompt, connection, sessionId));
  }

  private async runPromptTurn(
    turn: QwenAcpTurn,
    handle: MessageHandle,
    promptContent: ContentBlock[],
    connection: AcpConnectionHandle,
    sessionId: string,
  ): Promise<void> {
    try {
      await connection.connection.prompt({ sessionId, prompt: promptContent });
      const accumulatedText = turn.getAccumulatedText();
      const successResult: MessageResult = { outcome: 'completed', result: { message: accumulatedText } };
      await (this.config.bus as QwenAcpBus).emit(QwenAcpSubjects.turn_text_completed, {
        agentId: this.agentId,
        text: accumulatedText,
        timestamp: Date.now(),
      });
      // Flush BEFORE handle completion: shared-core usage attribution
      // (executionId/frameId) enriches from the active message handle,
      // which the lifecycle tracker clears once the handle completes.
      await this.flushAccumulatedUsage(Date.now());
      await markCompletedWithFinalResult(handle, successResult, (_handle, finalResult) => {
        this.lastResult = finalResult;
      });
    } catch (error) {
      if (turn.isPaused()) return;
      const err = error instanceof Error ? error : new Error(String(error));
      const errorResult: MessageResult = { outcome: 'error', error: err };
      await this.flushAccumulatedUsage(Date.now());
      await markCompletedWithFinalResult(handle, errorResult, (_handle, finalResult) => {
        this.lastResult = finalResult;
      });
    } finally {
      if (!turn.isPaused()) {
        await turn.markTurnFinished();
        await this.updateProcessingState('turn_finished');
        await this.updateProcessingState('processing_finished');
        this.pendingMessageHandle = undefined;
        const turnStarted = await this.processQueue();
        if (this.currentTurn === turn) this.currentTurn = undefined;
        if (!turnStarted) {
          await this.updateProcessingState('idle');
        }
      }
    }
  }

  /**
   * Merge per-chunk `_meta.usage` fields into the turn accumulator (last-wins).
   * Qwen ACP emits running totals on every `agent_message_chunk`, so the last
   * non-undefined value for each field is the correct per-turn total.
   * Actual emission is deferred to {@link flushAccumulatedUsage}.
   * @param meta - The `_meta` record from an ACP session update, if present
   */
  private accumulateUsageFromMeta(meta: Record<string, unknown> | null | undefined): void {
    if (this.turnUsageAccumulator === null) return;
    const usage = meta?.['usage'];
    if (usage == null || typeof usage !== 'object') return;
    const u = usage as Record<string, unknown>;
    const num = (key: string): number | undefined => (typeof u[key] === 'number' ? (u[key] as number) : undefined);
    const acc = this.turnUsageAccumulator;
    const inputTokens = num('inputTokens');
    const outputTokens = num('outputTokens');
    const totalTokens = num('totalTokens');
    const thoughtTokens = num('thoughtTokens');
    const cachedReadTokens = num('cachedReadTokens');
    if (inputTokens !== undefined) acc.inputTokens = inputTokens;
    if (outputTokens !== undefined) acc.outputTokens = outputTokens;
    if (totalTokens !== undefined) acc.totalTokens = totalTokens;
    if (thoughtTokens !== undefined) acc.thoughtTokens = thoughtTokens;
    if (cachedReadTokens !== undefined) acc.cachedReadTokens = cachedReadTokens;
  }

  /**
   * Emit the consolidated per-turn usage event and reset the accumulator.
   * Called once per turn in {@link runPromptTurn} on both success and error
   * paths, BEFORE the handle completes — the lifecycle tracker clears the
   * active correlation handle on completion, and shared-core attribution
   * (executionId/frameId) enriches usage from that active handle.
   * Emission failures are swallowed: usage telemetry must not break turn
   * completion; the bus logs handler errors.
   * @param timestamp - Timestamp to attach to the emitted event
   */
  private async flushAccumulatedUsage(timestamp: number): Promise<void> {
    const acc = this.turnUsageAccumulator;
    if (acc === null) return;
    this.turnUsageAccumulator = null;
    // Empty accumulator — stale state cleared, skip emission.
    if (Object.keys(acc).length === 0) return;
    try {
      await this.emit(QwenAcpSubjects.session_update_usage, {
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        totalTokens: acc.totalTokens,
        thoughtTokens: acc.thoughtTokens,
        cachedReadTokens: acc.cachedReadTokens,
        timestamp,
      });
    } catch {
      // Swallow: see method contract above.
    }
  }

  private async onSessionUpdate(notification: SessionNotification): Promise<void> {
    const timestamp = Date.now();
    const update = notification.update;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const delta = update.content.type === 'text' ? update.content.text : '';
        this.currentTurn?.appendText(delta);
        await this.startTurnStep('text');
        await this.emit(QwenAcpSubjects.session_update_message_chunk, { delta, timestamp });
        this.accumulateUsageFromMeta(update._meta);
        break;
      }
      case 'agent_thought_chunk': {
        const delta = update.content.type === 'text' ? update.content.text : '';
        await this.emit(QwenAcpSubjects.session_update_thought_chunk, { delta, timestamp });
        break;
      }
      case 'tool_call': {
        const messageId = this.pendingMessageHandle?.messageId;
        if (messageId !== undefined) this.toolCallMessageIds.set(update.toolCallId, messageId);
        this.lastToolCallId = update.toolCallId;
        await this.finishActiveTurnStep();
        await this.startTurnStep('tool_use');
        if (messageId !== undefined) {
          await this.emit(QwenAcpSubjects.session_update_tool_call, {
            messageId,
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind,
            rawInput: update.rawInput,
            timestamp,
          });
        }
        break;
      }
      case 'tool_call_update': {
        const messageId = this.toolCallMessageIds.get(update.toolCallId);
        if (messageId !== undefined) {
          await this.emit(QwenAcpSubjects.session_update_tool_call_update, {
            messageId,
            toolCallId: update.toolCallId,
            status: update.status ?? undefined,
            rawOutput: update.rawOutput,
            timestamp,
          });
        }
        if (update.status === 'completed' || update.status === 'failed') {
          this.toolCallMessageIds.delete(update.toolCallId);
          this.lastToolCallId = undefined;
          await this.finishActiveTurnStep();
        }
        break;
      }
      case 'usage_update':
        await this.emit(QwenAcpSubjects.session_update_context_window, {
          size: update.size,
          used: update.used,
          timestamp,
        });
        break;
      default:
        break;
    }
  }

  private async onRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    try {
      const response = await this.requestToolApprovalWithHandling(QwenAcpSubjects.permission_request, {
        toolCallId: params.toolCall.toolCallId,
        toolName: params.toolCall.title ?? undefined,
        args:
          typeof params.toolCall.rawInput === 'object' && params.toolCall.rawInput !== null
            ? (params.toolCall.rawInput as Record<string, unknown>)
            : {},
      });
      return mapApprovalToAcpResponse(response.action, params.options);
    } catch {
      return { outcome: { outcome: 'cancelled' } };
    }
  }

  /**
   * Gate a filesystem operation through the tool approval flow.
   * Throws on denial so the ACP agent sees a filesystem error.
   * Go/no-go gate only — updatedInput is ignored because ACP controls
   * execution. Args are path-only to keep approval UI payloads minimal.
   * @param toolName - Tool identifier for the approval request
   * @param args - Tool arguments for the approval payload
   */
  private async requestFsApproval(toolName: string, args: Record<string, unknown>): Promise<void> {
    const toolCallId = this.lastToolCallId ?? `fs:${toolName}`;
    const response = await this.requestToolApprovalWithHandling(QwenAcpSubjects.permission_request, {
      toolCallId,
      toolName,
      args,
    });
    // Implicit allow for any non-deny action (including future action types).
    // The ToolApprovalResponse contract is allow/deny; new actions would require
    // contract-level changes that update all callers.
    if (response.action === 'deny') {
      throw new Error(
        response.shouldAbort
          ? `Tool use denied by approval handler: ${response.message ?? `${toolName} denied`}`
          : (response.message ?? `${toolName} denied`),
      );
    }
  }

  /** @returns Filesystem execution context shared by read/write handlers. */
  private get fsExecutionContext() {
    return {
      bus: this.globalBus,
      adapterId: this.adapterId,
      adapterName: this.adapterName,
      cwd: this.cwd,
      sessionId: this.sessionId,
      agentId: this.agentId,
      turnId: this.pendingMessageHandle?.messageId,
      allowedDirectories: this.config.allowedDirectories,
    };
  }

  private async onReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    await this.requestFsApproval('read_file', { path: params.path });
    return executeAcpReadTextFile(params, this.fsExecutionContext);
  }

  private async onWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    await this.requestFsApproval('write_file', { path: params.path });
    return executeAcpWriteTextFile(params, this.fsExecutionContext);
  }

  private async createSystemPromptTempFile(
    systemPrompt: NonNullable<ConnectorStartOptions['systemPrompt']>,
  ): Promise<string> {
    const { randomUUID } = await import('node:crypto');
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const promptText = getSystemPromptText(systemPrompt);
    const tempPath = join(tmpdir(), `qwen-acp-system-${randomUUID()}.md`);
    await writeFile(tempPath, promptText, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    return tempPath;
  }

  private async cleanupTempFile(path: string | undefined): Promise<void> {
    if (!path) return;
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(path);
    } catch {
      // best-effort: file may already be removed
    }
  }

  private clearConnectionState(): void {
    this.lastToolCallId = undefined;
    this.toolCallMessageIds.clear();
    this.terminalManager.releaseAll();
    this.acpConnectionHandle?.kill();
    this.acpConnectionHandle = undefined;
    this.acpSessionId = undefined;
    this.adapterSessionId = undefined;
    this.isInitialized = false;
  }

  private async startTurnStep(stepType: 'text' | 'tool_use'): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) return;
    const previousState = turn.getState();
    await turn.markStepStarted(stepType);
    if (turn.getState() !== previousState) {
      await this.updateProcessingState('step_started');
    }
  }

  private async finishActiveTurnStep(): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) return;
    const previousState = turn.getState();
    await turn.markStepFinished();
    if (turn.getState() !== previousState) {
      await this.updateProcessingState('step_finished');
    }
  }
}
