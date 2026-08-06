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
  reportRepeatTeardown,
} from '@makaio/ai-adapters-core';
import type { ConnectorTeardownResult } from '@makaio/contracts';
import { createAcpConnection, MakaioAcpClient, TerminalManager } from '@makaio/ai-adapters-acp-client';
import type { AcpConnectionHandle } from '@makaio/ai-adapters-acp-client';
import { QwenAcpTurn } from './turn.js';
import { QwenAcpSubjects } from './namespaces/index.js';
import type { QwenAcpBus } from './namespaces/index.js';
import { mapApprovalToAcpResponse } from './permission.js';
import { QwenAcpProviderConfigSchema } from './schemas.js';
import {
  removeSystemPromptTempFile,
  shouldReinitializeSystemPrompt,
  writeSystemPromptTempFile,
} from './system-prompt.js';
import { SessionIdWaiters } from './session-id-waiters.js';
import { mergeUsageFromMeta, type TurnUsageAccumulator } from './turn-usage.js';
import { awaitCancelAcknowledgement, QwenRetirementLedgers, type QwenSupersededGenerations } from './teardown.js';
import { executeAcpReadTextFile, executeAcpWriteTextFile } from './tool-execution.js';
import { buildCliArgs } from './utils/build-cli-args.js';
import { buildPromptContent } from './utils/build-prompt.js';
import { toAcpMcpServers } from './utils/mcp-servers.js';
import { performAcpHandshake } from './utils/acp-handshake.js';
import type { QwenAcpConnectorConfig } from './types.js';
import { assertQwenNativeAuth } from './native-auth.js';
import { QWEN_ACP_AUTH_SCRUB_ENV_VARS } from './provider.js';

/** Refusal a caller receives when it asks a terminated connector to do work. */
const TERMINATED = 'QwenAcpConnector has already been terminated';

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

  /** Callers polling for the session ID; released on every termination path. */
  private readonly sessionIdWaiters = new SessionIdWaiters();

  /**
   * Processes this connector spawned, took out of service, and did not watch end
   * (I33) — the ACP agent and its terminal children alike. Neither leaves a runtime
   * handle for the layers above, so this connector is the last party that can report
   * them, and the ledgers are how it remembers to.
   */
  private readonly retirements = new QwenRetirementLedgers();

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
      spawnTimeoutMs: this.getTimeoutMs('initialization'),
    });
  }

  /**
   * Initialize the ACP session without sending a message. Idempotent.
   * @param options - Optional start options; captures system prompt for injection
   * @returns Resolves after the ACP session is ready
   */
  public async initialize(options?: ConnectorStartOptions): Promise<void> {
    if (this.isTerminated) throw new Error(TERMINATED);
    if (this.shouldReinitializeForSystemPrompt(options?.systemPrompt)) await this.resetConnection();
    // Re-checked after the reset: it awaits the predecessor's end, and a teardown
    // landing inside that window would otherwise be followed by a fresh spawn.
    if (this.isTerminated) throw new Error(TERMINATED);
    this.captureSystemPrompt(options?.systemPrompt);
    if (this.isInitialized) return;
    this.initializingPromise ??= this.initializeConnection()
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.sessionIdWaiters.rejectAll(err);
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

  /**
   * Interrupt the current turn via ACP `session/cancel` (best-effort).
   *
   * Also the cancel stage of {@link close}, which bounds this call rather than
   * repeating its guards: it resolves on every path — no live session means
   * nothing to cancel — so the budget lives with the caller that has one.
   */
  public async interrupt(): Promise<void> {
    if (!this.acpConnectionHandle || !this.acpSessionId) return;
    try {
      await this.acpConnectionHandle.connection.cancel({ sessionId: this.acpSessionId });
    } catch {
      // best-effort
    }
  }

  /**
   * Abort the connector immediately (panic mode). Kills subprocess.
   *
   * Synchronous by the connector contract, so it cannot await the ends it just
   * signalled. It therefore books every one of them as **unretired**, which caps
   * every class this connector reports afterwards at `detached` — the cap is what
   * keeps a synchronous retirement from quietly claiming what an asynchronous one
   * has to prove.
   */
  public abort(): void {
    if (this.isTerminated) return;
    this.isTerminated = true;
    this.retirements.abandon(this.clearConnectionState());
    if (this.currentTurn) this.currentTurn.markCompleted({ outcome: 'cancelled' });
    this.sessionIdWaiters.rejectAll();
    void this.cleanupSystemPromptTempFile();
  }

  /**
   * Gracefully shut down — cancel, kill, then watch — and report what was
   * observed.
   *
   * **Class: `exited`.** The local evidence is every process this connector spawned
   * — the `qwen` agent and the terminal children the shared ACP client opened for
   * it — each of which settles its own exit observation, and this close consumes
   * them inside the exit budget instead of discarding them. A signalled process
   * whose end does not arrive in that window reports `detached`, a connector that
   * never spawned one reports `released`, and any generation superseded earlier
   * without an observation caps the class however clean this close was (I33). The
   * cancel it asks for first is bounded and never reported — see
   * {@link awaitCancelAcknowledgement}.
   * @returns What this runtime observed about the ends of the processes it spawned.
   */
  public async close(): Promise<ConnectorTeardownResult> {
    if (this.isTerminated) return this.retirements.cap(reportRepeatTeardown());
    this.isTerminated = true;
    this.sessionIdWaiters.rejectAll();
    await awaitCancelAcknowledgement(() => this.interrupt());
    const superseded = this.clearConnectionState();
    await this.cleanupSystemPromptTempFile();
    return this.retirements.reportClose(superseded);
  }

  private async cleanupSystemPromptTempFile(): Promise<void> {
    if (!this.systemPromptTempFile) return;
    const path = this.systemPromptTempFile;
    this.systemPromptTempFile = undefined;
    await removeSystemPromptTempFile(path);
  }

  /**
   * Get the ACP session ID, rejecting if the connector terminates first.
   * @returns Resolved ACP session ID
   */
  public getAdapterSessionId(): Promise<string> {
    if (this.acpSessionId) return Promise.resolve(this.acpSessionId);
    if (this.isTerminated) return Promise.reject(SessionIdWaiters.terminatedError());
    return this.sessionIdWaiters.wait();
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
    const tempPath = capturedSystemPrompt ? await writeSystemPromptTempFile(capturedSystemPrompt) : undefined;
    if (tempPath) spawnEnv['QWEN_SYSTEM_MD'] = tempPath;

    const args = buildCliArgs({ model: this.model, providerConfig });
    // Every phase below waits on a counterparty that may never answer, so each
    // is bounded by the initialization budget this adapter already declares.
    // The budget was previously read only as definition metadata, which left the
    // spawn wait and both ACP round trips able to hang a start indefinitely —
    // and a teardown queued behind such a start hangs with it.
    const initializationTimeoutMs = this.getTimeoutMs('initialization');
    let handle: AcpConnectionHandle | undefined;
    try {
      handle = await createAcpConnection(() => client, {
        command,
        args,
        cwd: this.cwd,
        env: spawnEnv,
        spawnTimeoutMs: initializationTimeoutMs,
        onStderr: (data: string) => console.error(`[qwen-acp stderr] ${data}`),
        onError: (error: Error) => console.error('[qwen-acp spawn error]', error),
        onExit: (code: number | null) => {
          // Only the *current* generation's exit is a fault. A superseded one is
          // expected — the rebuild asked for it and is waiting on it. An exit before
          // `handle` is assigned belongs to a generation nobody published, and the
          // handshake failure is what reports that one.
          if (this.isTerminated) return;
          if (handle === undefined || this.acpConnectionHandle !== handle) return;
          this.handleError(new Error(`Qwen ACP exited: ${String(code)}`), true);
        },
      });

      // Thread upstream MCP servers from the session context into the ACP session.
      // Only the full McpSessionContext carries `servers`; narrow via property check.
      const mcpCtx = (this.config as QwenAcpConnectorConfig).mcpSessionContext;
      const session = await performAcpHandshake(handle.connection, {
        cwd: this.cwd,
        mcpServers: toAcpMcpServers(mcpCtx && 'servers' in mcpCtx ? mcpCtx.servers : undefined),
        budgetMs: initializationTimeoutMs,
      });

      this.acpConnectionHandle = handle;
      this.systemPromptTempFile = tempPath;
      this.acpSessionId = session.sessionId;
      this.adapterSessionId = this.acpSessionId;
      // The single statement that establishes a session ID, so it is also where the
      // callers that asked before it existed are released. No await between the two.
      this.sessionIdWaiters.resolveAll(this.acpSessionId);
      this.isInitialized = true;
    } catch (error) {
      // A failed init has spawned a `qwen` process whenever the connection was
      // established, so killing it is a retirement like any other and goes through
      // the choke point (I33). Booked without waiting, like `abort()` and for the
      // same reason: this path owes its caller an error promptly, so it signals the
      // end and gives up on observing it. The cap is what keeps giving up honest.
      if (handle !== undefined) this.retirements.abandonProcess(handle);
      await removeSystemPromptTempFile(tempPath);
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

  /**
   * Retire the live ACP generation so a replacement may start (I33).
   *
   * The rebuild path a late system prompt takes. It awaits the predecessor's own
   * end inside the exit budget rather than merely signalling it — starting a
   * second `qwen` while the first is unobserved is the hidden orphan this rule
   * exists for. Expiry does not fail the rebuild: a stuck predecessor must not
   * block a live agent, so the non-observation is booked and caps every class
   * this connector reports from then on.
   */
  private async resetConnection(): Promise<void> {
    const superseded = this.clearConnectionState();
    this.sessionIdWaiters.rejectAll();
    await this.cleanupSystemPromptTempFile();
    await this.retirements.retire(superseded);
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
   *
   * Outside a turn there is no accumulator and the update is dropped; the merge
   * itself lives in `turn-usage.ts` as a pure function of the two values.
   * Emission is deferred to {@link flushAccumulatedUsage}.
   * @param meta - The `_meta` record from an ACP session update, if present
   */
  private accumulateUsageFromMeta(meta: Record<string, unknown> | null | undefined): void {
    if (this.turnUsageAccumulator === null) return;
    mergeUsageFromMeta(this.turnUsageAccumulator, meta);
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

  /**
   * Signal the live ACP generation's end and drop every reference to it.
   *
   * The path taken by every act that ends the connector's **published** generation
   * — `abort()`, `close()` and `resetConnection()`. It resets the session-scoped
   * state and then hands both spawned resources — the ACP process and every terminal
   * child released with it — to the retirement choke points, where the kill and the
   * bookkeeping live together. What this method deliberately does *not* do is wait:
   * the synchronous caller cannot, and the two asynchronous ones differ only in how
   * they consume what it hands back.
   * @returns Every generation taken out of service, to retire or abandon.
   */
  private clearConnectionState(): QwenSupersededGenerations {
    this.lastToolCallId = undefined;
    this.toolCallMessageIds.clear();
    const terminals = this.retirements.supersedeTerminals(this.terminalManager.releaseAll());
    const handle = this.acpConnectionHandle;
    this.acpConnectionHandle = undefined;
    this.acpSessionId = undefined;
    this.adapterSessionId = undefined;
    this.isInitialized = false;
    return { process: handle === undefined ? undefined : this.retirements.supersedeProcess(handle), terminals };
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
