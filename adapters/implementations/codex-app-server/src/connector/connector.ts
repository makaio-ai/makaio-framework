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
} from '@makaio/ai-adapters-core';
import type { AIReasoningLevel } from '@makaio/contracts';
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
import { initializeConnection, type ConnectionManagerContext } from './connection-manager.js';
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
  private agentMessageContent: string = '';
  private notificationQueue: Promise<void> = Promise.resolve();
  private threadStartedDeferred?: {
    promise: Promise<string>;
    resolve: (threadId: string) => void;
  };
  private readonly _approvalPolicy?: ApprovalPolicy;
  private readonly _sandboxMode?: SandboxMode;
  private readonly _reasoningEffort?: ReasoningEffort;
  private readonly commandExecutionByItemId = new Map<string, { command: string; cwd: string }>();
  private readonly dynamicToolCallByItemId = new Map<string, DynamicToolCallCacheEntry>();
  /** Pending resolvers for {@link waitForCommandInfo}, keyed by itemId. */
  private readonly commandInfoWaiters = new Map<string, (info: { command: string; cwd: string }) => void>();
  private disabledNativeTools: ReadonlySet<string> = new Set();

  /**
   * Stable context object passed to connection-manager module functions.
   * All state access is via closures over `this` so the object is never stale.
   */
  private readonly connCtx: ConnectionManagerContext;
  /**
   * Stable context object passed to turn-flow-handlers module functions.
   * All state access is via closures over `this` so the object is never stale.
   */
  private readonly turnCtx: TurnFlowContext;

  public constructor(config: CodexAppServerConfig) {
    super({
      bus: config.bus,
      adapterId: config.adapterId,
      adapterName: config.adapterName ?? 'codex-app-server',
      agentId: config.agentId,
      model: config.model,
      cwd: config.cwd,
      env: config.env,
      onMessageSent: config.onMessageSent,
      toolLedger: config.toolLedger,
      reasoningEffort: config.reasoningEffort,
      clientId: config.clientId,
      harnessId: config.harnessId,
      providerContext: config.providerContext,
    });

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
    this.turnCtx = this.buildTurnFlowContext();
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
      providerContext: this.config.providerContext,
      clientId: this.config.clientId,
      harnessId: this.config.harnessId,
      bus: this.config.bus,
      registerClientHandlers: () => this.registerClientHandlers(),
      handleError: (error, terminate) => this.handleError(error, terminate),
    };
  }

  private buildTurnFlowContext(): TurnFlowContext {
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
      setAgentMessageContent: (content) => {
        this.agentMessageContent = content;
      },
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

  /**
   * Resolve any pending {@link waitForCommandInfo} promise for `itemId`.
   * Called by the `item/started` lifecycle path after populating `commandExecutionByItemId`.
   * @param itemId - Item now available in commandExecutionByItemId
   * @param info - Command execution metadata just written to the cache
   */
  private notifyCommandInfoReady(itemId: string, info: { command: string; cwd: string }): void {
    const resolve = this.commandInfoWaiters.get(itemId);
    if (resolve) {
      this.commandInfoWaiters.delete(itemId);
      resolve(info);
    }
  }

  /**
   * Return `commandExecutionByItemId` entry for `itemId` immediately if present,
   * otherwise wait up to 5 seconds for `item/started` to populate it.
   * Returns `undefined` on timeout so callers can degrade gracefully.
   * @param itemId - Item ID to wait for
   * @returns Command execution metadata, or `undefined` on timeout
   */
  private waitForCommandInfo(itemId: string): Promise<{ command: string; cwd: string } | undefined> {
    const existing = this.commandExecutionByItemId.get(itemId);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.commandInfoWaiters.delete(itemId);
        resolve(undefined);
      }, 5000);
      this.commandInfoWaiters.set(itemId, (info) => {
        clearTimeout(timeout);
        resolve(info);
      });
    });
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
      commandExecutionByItemId: this.commandExecutionByItemId,
      dynamicToolCallByItemId: this.dynamicToolCallByItemId,
      updateProcessingState: this.updateProcessingState.bind(this),
      appendAgentMessageDelta: (delta) => {
        this.agentMessageContent += delta;
      },
      onTurnCompleted: (n: TurnCompletedNotification) => onTurnCompleted(tfCtx, n),
      getThread: () => this.thread,
      handleAsyncError: (error) => this.handleError(error),
      onCommandInfoReady: this.notifyCommandInfoReady.bind(this),
    });
    registerServerRequestHandler({
      client,
      agentId: this.agentId,
      cwd: this.cwd ?? '',
      commandExecutionByItemId: this.commandExecutionByItemId,
      requestToolApproval: this.requestToolApproval.bind(this) as ApprovalContext['requestToolApproval'],
      handleError: this.handleError.bind(this),
      getDisabledNativeTools: () => this.disabledNativeTools,
      handleDynamicToolCallRequest: this.handleDynamicToolCallRequest.bind(this),
      waitForCommandInfo: this.waitForCommandInfo.bind(this),
    });
    this.clientHandlersRegistered = true;
  }

  private async handleDynamicToolCallRequest(
    params: DynamicToolCallServerRequest['params'],
  ): Promise<DynamicToolCallResponse> {
    return handleDynamicToolCallApprovalRequest(params, {
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

  public async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    if (!this.isConnected) await initializeConnection(this.connCtx, this.initConnectionInflight);
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
    this.jsonRpcClient?.close();
  }

  public async close(): Promise<void> {
    if (this.isTerminated) return;
    this.isTerminated = true;
    await this.archiveThread();
    this.jsonRpcClient?.close();
  }

  // jsonRpcClient is guaranteed initialized: archiveThread is only called
  // from close(), which is only reachable after initialize()/start() have run.
  private async archiveThread(): Promise<void> {
    const threadId = this.thread?.threadId;
    if (!threadId) return;
    const archiveRequest = this.jsonRpcClient?.request('thread/archive', { threadId });
    if (!archiveRequest) return;

    try {
      await Promise.race([
        archiveRequest,
        new Promise((_, reject) => setTimeout(() => reject(new Error('archive timeout')), 2000)),
      ]);
    } catch {
      // Best-effort — process may already be unresponsive
    }
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
