/* eslint max-lines: ["error", { "max": 450 }] */
import {
  AIAgentConnector,
  type AgentStartResult,
  type ConnectorSendMessageOptions,
  type ConnectorStartOptions,
  type MessageHandle,
  type MessageResult,
  type NormalizedMessageInput,
  UserMessageQueue,
  GenerationRetirementLedger,
} from '@makaio/ai-adapters-core';
import type { AIReasoningLevel, ConnectorTeardownResult } from '@makaio/contracts';
import type { ThreadStartedNotification, TurnCompletedNotification } from '../protocol/generated/v2/index.js';
import type { CodexAppServerBus } from '../namespaces/index.js';
import { CodexAppServerThread } from '../thread.js';
import { CodexAppServerTurn } from '../turn.js';
import type { JsonRpcClient } from '../utils/jsonRpcClient.js';
import type { StdioTransport } from '../utils/createStdioTransport.js';
import { type CodexAppServerConfig, type ApprovalPolicy, type SandboxMode, type ReasoningEffort } from './types.js';
import { handleDynamicToolCallApprovalRequest, type ApprovalContext } from './approval-handlers.js';
import { registerNotificationHandlers, registerServerRequestHandler } from './client-handlers.js';
import {
  type DynamicToolCallCacheEntry,
  type DynamicToolCallServerRequest,
  type DynamicToolCallResponse,
} from '../dynamic-tool-handling.js';
import { connectorTransport, initializeConnection, type ConnectionManagerContext } from './connection-manager.js';
import { resolveCodexApiKeyAccountLogin, type CodexApiKeyAccountLogin } from './account-login.js';
import {
  abortCodexConnection,
  archiveCodexThread,
  closeCodexConnection,
  reportAfterCodexTermination,
  reportCodexShutdown,
  requestedShutdownExitError,
  type CodexTerminalTeardownNote,
} from './connector-shutdown.js';
import { CommandInfoRegistry } from './command-info-registry.js';
import {
  startThread,
  processQueue,
  onThreadStarted,
  onTurnCompleted,
  type TurnFlowContext,
} from './turn-flow-handlers.js';

export class CodexAppServerConnector extends AIAgentConnector<CodexAppServerBus> {
  /** Lazy: initialised in initializeConnection(); public methods access via getJsonRpcClient(). */
  private jsonRpcClient?: JsonRpcClient;
  /** Injected transport for tests; null means "create from subprocess on first connect". */
  private readonly _injectedTransport?: StdioTransport;
  /** Injected JSON-RPC client for tests; bypasses subprocess creation entirely. */
  private readonly _injectedJsonRpcClient?: JsonRpcClient;
  /** Transport owned by this connector and safe to tear down after partial startup failures. */
  private ownedTransport?: StdioTransport;
  private readonly messageQueue = new UserMessageQueue();
  private thread?: CodexAppServerThread;
  private currentTurn?: CodexAppServerTurn;
  private isConnected = false;
  /** In-flight connection initialization promise for single-flight deduplication. */
  private readonly initConnectionInflight: { promise: Promise<void> | undefined } = { promise: undefined };
  /** Handlers are registered once per client instance to avoid duplicate listeners on retries. */
  private clientHandlersRegistered = false;
  private isTerminated = false;
  /** How the teardown that set {@link isTerminated} ended, read by every later one. */
  private readonly terminalTeardown: CodexTerminalTeardownNote = {};
  /** Superseded app-server generations (I33): retired at `resetClient`, read by every teardown. */
  private readonly generations = new GenerationRetirementLedger('codex app-server process');
  private agentMessageContent: string = '';
  private notificationQueue: Promise<void> = Promise.resolve();
  private threadStartedDeferred?: {
    promise: Promise<string>;
    resolve: (threadId: string) => void;
  };
  private readonly _approvalPolicy?: ApprovalPolicy;
  private readonly _sandboxMode?: SandboxMode;
  private readonly _reasoningEffort?: ReasoningEffort;
  private readonly commandInfo = new CommandInfoRegistry();
  private readonly dynamicToolCallByItemId = new Map<string, DynamicToolCallCacheEntry>();
  private disabledNativeTools: ReadonlySet<string> = new Set();
  /** Private connector delivery retained only until this connector closes. */
  private accountLogin: CodexApiKeyAccountLogin | undefined;

  /** Stable contexts passed to connection-manager and turn-flow-handlers; state accessed via closures. */
  private readonly connCtx: ConnectionManagerContext;
  private readonly turnCtx: TurnFlowContext;

  public constructor(config: CodexAppServerConfig) {
    const { adapterAuth, ...baseConfig } = config;
    // A missing host environment is a closed input. The central runtime passes
    // the finalized environment explicitly; direct construction must not fall
    // back to ambient process authentication in the base connector.
    super({ ...baseConfig, env: baseConfig.env ?? {} });
    this.accountLogin = resolveCodexApiKeyAccountLogin(adapterAuth);

    const fullConfig = config as CodexAppServerConfig & {
      providerConfig?: { approvalPolicy?: string; sandboxMode?: string; reasoningEffort?: string };
    };
    this._approvalPolicy = (fullConfig.providerConfig?.approvalPolicy as ApprovalPolicy) ?? fullConfig.approvalPolicy;
    this._sandboxMode = (fullConfig.providerConfig?.sandboxMode as SandboxMode) ?? fullConfig.sandboxMode;
    this._reasoningEffort =
      (fullConfig.providerConfig?.reasoningEffort as ReasoningEffort) ?? fullConfig.reasoningEffort;
    // Sync base-class field with the resolved value (providerConfig may override config.reasoningEffort).
    this.currentReasoningEffort = this._reasoningEffort;

    // Store injected test doubles; subprocess creation is deferred to initializeConnection().
    this._injectedJsonRpcClient = config.jsonRpcClient;
    this._injectedTransport = config.transport;

    // Assign eagerly so abort()/close() can reference the client before initializeConnection() runs.
    if (config.jsonRpcClient) {
      this.jsonRpcClient = config.jsonRpcClient;
    }

    this.connCtx = this.buildConnectionContext();
    // buildTurnFlowContext deliberately mixes sourcing: config-sourced initial directives
    // (resumeAdapterSessionId — later consumed by suppressed resume — and nativeFork) are snapshot
    // from `config`, while getter-backed fields (model, approvalPolicy, reasoningEffort) are
    // live-read from `this` per turn.
    this.turnCtx = this.buildTurnFlowContext(config);
  }

  private buildConnectionContext(): ConnectionManagerContext {
    return {
      getJsonRpcClient: () => this.jsonRpcClient,
      setJsonRpcClient: (client) => {
        this.jsonRpcClient = client;
      },
      getInjectedJsonRpcClient: () => this._injectedJsonRpcClient,
      getInjectedTransport: () => this._injectedTransport,
      getOwnedTransport: () => this.ownedTransport,
      setOwnedTransport: (transport) => {
        this.ownedTransport = transport;
      },
      getIsConnected: () => this.isConnected,
      setIsConnected: (value) => {
        this.isConnected = value;
      },
      setClientHandlersRegistered: (value) => {
        this.clientHandlersRegistered = value;
      },
      setDisabledNativeTools: (tools) => {
        this.disabledNativeTools = tools;
      },
      cwd: this.cwd,
      env: this.env,
      adapterName: this.adapterName,
      clientId: this.config.clientId,
      clientExecution: this.config.clientExecution,
      getAccountLogin: () => this.accountLogin,
      harnessId: this.config.harnessId,
      globalBus: this.globalBus,
      generations: this.generations,
      registerClientHandlers: () => this.registerClientHandlers(),
      handleError: (error, terminate) => this.handleError(error, terminate),
      finalizeRequestedShutdown: (code, terminate) => this.handleError(requestedShutdownExitError(code), terminate),
    };
  }

  private buildTurnFlowContext(config: CodexAppServerConfig): TurnFlowContext {
    return {
      getCurrentTurn: () => this.currentTurn,
      setCurrentTurn: (turn) => {
        this.currentTurn = turn;
      },
      getThread: () => this.thread,
      setThread: (thread) => {
        this.thread = thread;
      },
      getAgentMessageContent: () => this.agentMessageContent,
      setAgentMessageContent: (content) => (this.agentMessageContent = content),
      getPendingMessageHandle: () => this.pendingMessageHandle,
      setPendingMessageHandle: (handle) => {
        this.pendingMessageHandle = handle;
      },
      setLastResult: (result) => {
        this.lastResult = result;
      },
      getLastResult: () => this.lastResult,
      setAdapterSessionId: (id) => {
        this.adapterSessionId = id;
      },
      getThreadStartedDeferred: () => this.threadStartedDeferred,
      setThreadStartedDeferred: (deferred) => {
        this.threadStartedDeferred = deferred;
      },
      messageQueue: this.messageQueue,
      getJsonRpcClient: () => this.getJsonRpcClient(),
      emit: this.emit.bind(this),
      updateProcessingState: this.updateProcessingState.bind(this),
      agentId: this.agentId,
      adapterId: this.adapterId,
      adapterName: this.adapterName,
      bus: this.config.bus,
      globalBus: this.globalBus,
      getModel: () => this.model,
      getReasoningEffort: () => this.currentReasoningEffort,
      getApprovalPolicy: () => this._approvalPolicy,
      getSandboxMode: () => this._sandboxMode,
      resolveSystemPrompt: () => this.resolveSystemPrompt(),
      cwd: this.cwd,
      allowedTools: this.config.allowedTools,
      disallowedTools: this.config.disallowedTools,
      resumeAdapterSessionId: config.resumeAdapterSessionId,
      nativeFork: config.nativeFork,
    };
  }

  public get approvalPolicy(): ApprovalPolicy | undefined {
    return this._approvalPolicy;
  }

  public get sandboxMode(): SandboxMode | undefined {
    return this._sandboxMode;
  }

  public get reasoningEffort(): ReasoningEffort | undefined {
    return this._reasoningEffort;
  }

  private resolveSystemPrompt(): string | null {
    if (this.systemPrompt === undefined) return null;
    return typeof this.systemPrompt === 'string' ? this.systemPrompt : this.systemPrompt.content;
  }

  private enqueueNotification(handler: () => Promise<void>): void {
    this.notificationQueue = this.notificationQueue.then(handler).catch((error) => {
      console.error('[CodexAppServerConnector] Notification handler error:', error);
    });
  }

  private getJsonRpcClient(): JsonRpcClient {
    if (!this.jsonRpcClient) {
      throw new Error('JSON-RPC client not initialized');
    }
    return this.jsonRpcClient;
  }

  private registerClientHandlers(): void {
    if (this.clientHandlersRegistered) return;
    const client = this.getJsonRpcClient();
    const tfCtx = this.turnCtx;
    registerNotificationHandlers({
      client,
      enqueueNotification: this.enqueueNotification.bind(this),
      onThreadStarted: (n: ThreadStartedNotification) => onThreadStarted(tfCtx, n),
      consumeTurnNumber: this.consumeTurnNumber.bind(this),
      getCurrentTurn: () => this.currentTurn,
      emit: this.emit.bind(this),
      commandExecutionByItemId: this.commandInfo.byItemId,
      dynamicToolCallByItemId: this.dynamicToolCallByItemId,
      updateProcessingState: this.updateProcessingState.bind(this),
      appendAgentMessageDelta: (delta) => {
        this.agentMessageContent += delta;
      },
      setAgentMessageContent: tfCtx.setAgentMessageContent,
      onTurnCompleted: (n: TurnCompletedNotification) => onTurnCompleted(tfCtx, n),
      getThread: () => this.thread,
      handleAsyncError: (error) => this.handleError(error),
      onCommandInfoReady: (itemId, info) => this.commandInfo.notifyReady(itemId, info),
    });
    registerServerRequestHandler({
      client,
      agentId: this.agentId,
      cwd: this.cwd ?? '',
      commandExecutionByItemId: this.commandInfo.byItemId,
      requestToolApproval: this.requestToolApproval.bind(this) as ApprovalContext['requestToolApproval'],
      handleError: this.handleError.bind(this),
      getDisabledNativeTools: () => this.disabledNativeTools,
      handleDynamicToolCallRequest: this.handleDynamicToolCallRequest.bind(this),
      waitForCommandInfo: (itemId) => this.commandInfo.waitFor(itemId),
    });
    this.clientHandlersRegistered = true;
  }

  private async handleDynamicToolCallRequest(
    params: DynamicToolCallServerRequest['params'],
  ): Promise<DynamicToolCallResponse> {
    return handleDynamicToolCallApprovalRequest(params, {
      bus: this.globalBus,
      requestToolApproval: this.requestToolApproval.bind(this) as (
        subject: unknown,
        payload: unknown,
      ) => Promise<{ decision: 'accept' | 'decline'; message?: string }>,
      emit: this.emit.bind(this),
      sessionId: this.sessionId,
      adapterSessionId: this.adapterSessionId,
      agentId: this.agentId,
      adapterId: this.adapterId,
      adapterName: this.adapterName,
      dynamicToolCallByItemId: this.dynamicToolCallByItemId,
      toolLedger: this.config.toolLedger,
      currentTurnNumber: this.currentTurnNumber,
    });
  }

  // Eager warmup path: connects and starts the thread without enqueuing a
  // message. sendMessage() carries the same idempotent guards as lazy fallback,
  // so calling initialize() followed by sendMessage() is safe (no double-init).
  public async initialize(options?: ConnectorStartOptions): Promise<void> {
    this.captureSystemPrompt(options?.systemPrompt);
    if (!this.isConnected) await initializeConnection(this.connCtx, this.initConnectionInflight);
    if (!this.thread) await startThread(this.turnCtx);
  }

  public async start(message: NormalizedMessageInput, options?: ConnectorStartOptions): Promise<AgentStartResult> {
    this.captureSystemPrompt(options?.systemPrompt);
    const messageHandle = await this.sendMessage(message, options);

    return {
      adapterSessionId: await this.getAdapterSessionId(),
      messageHandle,
      agentId: this.agentId,
    };
  }

  /**
   * Codex abandons an armed resume target on suppressed native resume: the
   * turn-flow context feeds `thread/resume` directly, so declining resume
   * mints a fresh thread and the armed target stops being valid resume
   * currency. `true` while that target is armed and no thread has been
   * started — once a thread exists the provider has committed an identity and
   * nothing is pending. Left at the base `false`, the movement seam would read
   * the seeded `adapterSessionId` and conclude nothing moved, leaving the
   * session row advertising the abandoned thread until the fresh one confirms
   * (contract in `agent/agent-adapter-session-movement.ts`).
   * @returns `true` while an unconfirmed resume target is armed
   */
  public override movesProviderSessionOnSuppressedResume(): boolean {
    return this.thread === undefined && this.turnCtx.resumeAdapterSessionId !== undefined;
  }

  public async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    if (!this.isConnected) await initializeConnection(this.connCtx, this.initConnectionInflight);
    // Suppress before startThread: that function reads turnCtx.resumeAdapterSessionId directly;
    // options is not forwarded to it, so clearing it here is the only point suppression applies.
    // The clear is deliberately NOT restored when startThread rejects: the executor announced the
    // abandonment (unconfirmed move) before this dispatch, so the session row already stopped
    // advertising the old thread. Resurrecting the target would let a later dispatch resume a
    // thread whose abandonment was announced, the bug class this guard closed. Recovery after a
    // failed fresh start is the service tier's decision (fresh-with-history), not the connector's.
    if (!this.thread && options?.useNativeResume === false) this.turnCtx.resumeAdapterSessionId = undefined;
    if (!this.thread) await startThread(this.turnCtx);

    const handle = this.createMessageHandle(message, options);
    const wasIdle = this.getProcessingState() === 'idle';

    if (wasIdle) await this.updateProcessingState('active');

    this.messageQueue.enqueue(handle);

    const noActiveTurn = !this.currentTurn || this.currentTurn.isCompleted();
    if (noActiveTurn) await processQueue(this.turnCtx);

    return handle;
  }

  /**
   * Codex supports per-turn model switching via `turn/start`.
   * The caller updates `this.model` after this returns true.
   * @param _newModel - The model identifier (unused — read from `this.model` at turn start)
   * @returns Always `true`
   */
  public override async changeModelInPlace(_newModel: string): Promise<boolean> {
    return true;
  }

  /**
   * Codex passes reasoning effort per-turn via `turn/start`; `startTurn` reads
   * `this.currentReasoningEffort` at send time, so no SDK reconfiguration is needed.
   * @param _newLevel - Unused — read from `this.currentReasoningEffort` at turn start
   * @returns Always `true`
   */
  public override async changeReasoningInPlace(_newLevel: AIReasoningLevel): Promise<boolean> {
    return true;
  }

  public async interrupt(): Promise<void> {
    if (!this.currentTurn?.getTurnId()) return;
    await this.getJsonRpcClient().request('turn/interrupt', { turnId: this.currentTurn.getTurnId() });
  }

  public async getAdapterSessionId(): Promise<string> {
    if (this.adapterSessionId) return this.adapterSessionId;
    if (this.threadStartedDeferred) return this.threadStartedDeferred.promise;
    throw new Error('Thread not started');
  }

  public async complete(): Promise<MessageResult | null> {
    while (this.getProcessingState() !== 'idle') {
      await this.onceProcessingStateChanged();
    }
    return this.lastResult;
  }

  public abort(): void {
    if (this.isTerminated) return;
    this.isTerminated = true;
    abortCodexConnection({
      closeClient: () => this.jsonRpcClient?.close(),
      discardAuth: () => void (this.accountLogin = undefined),
      note: this.terminalTeardown,
    });
  }

  /**
   * Gracefully close the connector and report what was observed.
   *
   * **Class: `exited`,** from the spawned process's own exit observation;
   * {@link reportCodexShutdown} states the evidence and the two weaker answers. A
   * failing stage still throws, which the layer above reads as `unknown`. A caller
   * arriving after the marker inherits how *that* teardown ended, so a known-failed
   * one is not laundered into `detached` — see {@link reportAfterCodexTermination}.
   * @returns What this runtime observed about the end of its app-server process.
   */
  public async close(): Promise<ConnectorTeardownResult> {
    if (this.isTerminated) return this.generations.capReport(reportAfterCodexTermination(this.terminalTeardown));
    this.isTerminated = true;
    // Read before the close: the reset paths clear the reference.
    const transport = connectorTransport(this.connCtx);
    await closeCodexConnection({
      archive: () =>
        archiveCodexThread(this.thread?.threadId, (id) =>
          this.jsonRpcClient?.request('thread/archive', { threadId: id }),
        ),
      closeClient: () => this.jsonRpcClient?.close(),
      discardAuth: () => void (this.accountLogin = undefined),
      note: this.terminalTeardown,
    });
    return reportCodexShutdown(transport, this.generations);
  }

  protected acceptsImmediate(): boolean {
    if (!this.currentTurn) return true;
    return this.currentTurn.canAcceptImmediate();
  }

  public override handleError(error: unknown, terminate = false): void {
    const err = error instanceof Error ? error : new Error(String(error));
    if (this.pendingMessageHandle && !this.pendingMessageHandle.isProcessed) {
      this.lastResult = { outcome: 'error', error: err };
    }
    super.handleError(err, terminate);
  }
}
