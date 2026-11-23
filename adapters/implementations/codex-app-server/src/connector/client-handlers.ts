import type { CallContext } from '@makaio/contracts';
import type { ServerRequest } from '../protocol/generated/index.js';
import type { MessageHandle, ProcessingState } from '@makaio/ai-adapters-core';
import type {
  ItemCompletedNotification,
  ItemStartedNotification,
  ThreadStartedNotification,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnStartedNotification,
} from '../protocol/generated/v2/index.js';
import type { JsonRpcClient } from '../utils/jsonRpcClient.js';
import {
  handleAgentMessageDelta,
  handleCommandOutputDelta,
  handleReasoningDelta,
  handleFileChangeDelta,
} from './delta-handlers.js';
import {
  handleCommandApprovalRequest,
  handleFileChangeApprovalRequest,
  type ApprovalContext,
} from './approval-handlers.js';
import {
  handleTurnStarted,
  handleItemStarted,
  handleItemCompleted,
  handleTokenUsageUpdated,
} from './lifecycle-handlers.js';
import {
  isDynamicToolCallRequest,
  type DynamicToolCallCacheEntry,
  type DynamicToolCallResponse,
  type DynamicToolCallServerRequest,
} from '../dynamic-tool-handling.js';
import type { CodexAppServerThread } from '../thread.js';
import type { CodexAppServerTurn } from '../turn.js';
import type { CodexCallEmit, CodexTurnEmit } from './turn-flow-handlers.js';

/**
 * Read the turn identifier a notification carries.
 * @param params - Raw notification params
 * @returns The `turnId` string, or `undefined` when the notification carries none
 */
function turnIdOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null || !('turnId' in params)) return undefined;
  return typeof params.turnId === 'string' ? params.turnId : undefined;
}

interface NotificationHandlerOptions {
  client: JsonRpcClient;
  enqueueNotification: (handler: () => Promise<void>) => void;
  onThreadStarted: (call: CallContext, params: ThreadStartedNotification) => Promise<void>;
  consumeTurnNumber: () => number;
  getCurrentTurn: () => CodexAppServerTurn | undefined;
  /**
   * Publishes the association between a provider turn id and the pending handle. Called
   * synchronously at the `turn/started` ingress so that lookups at the ingress of later
   * notifications never depend on the queued turn handler.
   */
  publishTurnAssociation: (providerTurnId: string) => void;
  /**
   * Returns the pending handle of the given provider turn, or `undefined` when none is attributable.
   * Read synchronously at callback ingress, before any `await`.
   */
  handleForTurn: (turnId: string) => MessageHandle | undefined;
  /**
   * Binds an emitter to the operation of one callback: the call of the handle attributable to
   * `turnId` (or to the most recent started, not yet completed turn when `turnId` is `undefined`),
   * the observer context otherwise. Evaluated at callback ingress, before any `await`.
   */
  bindEmit: (turnId: string | undefined) => CodexTurnEmit;
  /** Resolves the message call or observer origin synchronously at notification ingress. */
  callForTurn: (turnId: string | undefined) => CallContext;
  emit: CodexCallEmit;
  commandExecutionByItemId: Map<string, { command: string; cwd: string }>;
  dynamicToolCallByItemId: Map<string, DynamicToolCallCacheEntry>;
  updateProcessingState: (state: ProcessingState) => Promise<void>;
  appendAgentMessageDelta: (delta: string) => void;
  setAgentMessageContent: (content: string) => void;
  onTurnCompleted: (params: TurnCompletedNotification, handle: MessageHandle | undefined) => Promise<void>;
  getThread: () => CodexAppServerThread | undefined;
  handleAsyncError: (error: unknown) => void;
  /** Invoked after a commandExecution entry is written to commandExecutionByItemId. */
  onCommandInfoReady: (itemId: string, info: { command: string; cwd: string }) => void;
}

interface ServerRequestHandlerOptions {
  client: JsonRpcClient;
  agentId: string;
  cwd: string;
  commandExecutionByItemId: Map<string, { command: string; cwd: string }>;
  requestToolApproval: ApprovalContext['requestToolApproval'];
  handleForTurn: ApprovalContext['handleForTurn'];
  handleError: (error: unknown, terminate?: boolean) => void;
  getDisabledNativeTools: () => ReadonlySet<string>;
  handleDynamicToolCallRequest: (params: DynamicToolCallServerRequest['params']) => Promise<DynamicToolCallResponse>;
  waitForCommandInfo: ApprovalContext['waitForCommandInfo'];
}

/**
 * Register the streaming delta callbacks. Each binds its emitter at ingress, before anything else runs.
 * @param client - JSON-RPC client to register the callbacks on
 * @param bindEmit - Emitter binder, see {@link NotificationHandlerOptions.bindEmit}
 * @param appendAgentMessageDelta - Accumulates agent message delta text
 * @param handleAsyncError - Terminal error sink for fire-and-forget handler rejections
 */
function registerDeltaHandlers(
  client: JsonRpcClient,
  bindEmit: NotificationHandlerOptions['bindEmit'],
  appendAgentMessageDelta: (delta: string) => void,
  handleAsyncError: (error: unknown) => void,
): void {
  // Streaming deltas bypass the serialized notification queue so token/file output stays low-latency.
  // Each handler still terminates in handleAsyncError to avoid unhandled rejections on fire-and-forget paths.
  client.onNotification('item/agentMessage/delta', (_method, params) => {
    const emit = bindEmit(turnIdOf(params));
    void handleAgentMessageDelta(emit, params, appendAgentMessageDelta).catch(handleAsyncError);
  });

  client.onNotification('item/commandExecution/outputDelta', (_method, params) => {
    const emit = bindEmit(turnIdOf(params));
    void handleCommandOutputDelta(emit, params).catch(handleAsyncError);
  });

  client.onNotification('item/reasoning/textDelta', (_method, params) => {
    const emit = bindEmit(turnIdOf(params));
    void handleReasoningDelta(emit, params).catch(handleAsyncError);
  });

  client.onNotification('item/fileChange/outputDelta', (_method, params) => {
    const emit = bindEmit(turnIdOf(params));
    void handleFileChangeDelta(emit, params).catch(handleAsyncError);
  });
}

/**
 * Register JSON-RPC notification handlers for the connector client instance.
 * @param options - Callbacks and state accessors used to bridge notifications into connector state
 */
export function registerNotificationHandlers(options: NotificationHandlerOptions): void {
  const {
    client,
    enqueueNotification,
    onThreadStarted,
    consumeTurnNumber,
    getCurrentTurn,
    publishTurnAssociation,
    handleForTurn,
    bindEmit,
    callForTurn,
    emit,
    commandExecutionByItemId,
    dynamicToolCallByItemId,
    updateProcessingState,
    appendAgentMessageDelta,
    setAgentMessageContent,
    onTurnCompleted,
    getThread,
    handleAsyncError,
    onCommandInfoReady,
  } = options;

  client.onNotification('thread/started', (_method, params) => {
    const call = callForTurn(undefined);
    enqueueNotification(() => onThreadStarted(call, params as ThreadStartedNotification));
  });

  client.onNotification('turn/started', (_method, params) => {
    publishTurnAssociation((params as TurnStartedNotification).turn.id);
    const call = callForTurn((params as TurnStartedNotification).turn.id);
    consumeTurnNumber();
    enqueueNotification(() =>
      handleTurnStarted(call, params as TurnStartedNotification, getCurrentTurn(), updateProcessingState),
    );
  });

  // Lifecycle callbacks capture their call at ingress, before the notification queue or an await runs.
  client.onNotification('item/started', (_method, params) => {
    const call = callForTurn(turnIdOf(params));
    enqueueNotification(() =>
      handleItemStarted(
        call,
        params as ItemStartedNotification,
        getCurrentTurn(),
        emit,
        commandExecutionByItemId,
        dynamicToolCallByItemId,
        updateProcessingState,
        onCommandInfoReady,
      ),
    );
  });

  client.onNotification('item/completed', (_method, params) => {
    const call = callForTurn(turnIdOf(params));
    enqueueNotification(() =>
      handleItemCompleted(
        call,
        params as ItemCompletedNotification,
        getCurrentTurn(),
        emit,
        commandExecutionByItemId,
        dynamicToolCallByItemId,
        updateProcessingState,
        setAgentMessageContent,
      ),
    );
  });

  registerDeltaHandlers(client, bindEmit, appendAgentMessageDelta, handleAsyncError);

  client.onNotification('turn/completed', (_method, params) => {
    const completed = params as TurnCompletedNotification;
    const handle = handleForTurn(completed.turn.id);
    enqueueNotification(() => onTurnCompleted(completed, handle));
  });

  client.onNotification('thread/tokenUsage/updated', (_method, params) => {
    const call = callForTurn(turnIdOf(params));
    void handleTokenUsageUpdated(call, params as ThreadTokenUsageUpdatedNotification, getThread()).catch(
      handleAsyncError,
    );
  });
}

/**
 * Register the JSON-RPC server-request handler for approval and dynamic tool call flows.
 * @param options - Callbacks and state accessors needed to answer server requests
 */
export function registerServerRequestHandler(options: ServerRequestHandlerOptions): void {
  const ctx: ApprovalContext = {
    agentId: options.agentId,
    cwd: options.cwd,
    commandExecutionByItemId: options.commandExecutionByItemId,
    requestToolApproval: options.requestToolApproval,
    handleForTurn: options.handleForTurn,
    handleError: options.handleError,
    getDisabledNativeTools: options.getDisabledNativeTools,
    waitForCommandInfo: options.waitForCommandInfo,
  };

  options.client.onServerRequest(async (request: ServerRequest) => {
    const asMethodRequest: { method: string } = request;
    if (isDynamicToolCallRequest(asMethodRequest)) {
      return options.handleDynamicToolCallRequest(asMethodRequest.params);
    }
    if (request.method === 'item/commandExecution/requestApproval') {
      return handleCommandApprovalRequest(request, ctx);
    }
    if (request.method === 'item/fileChange/requestApproval') {
      return handleFileChangeApprovalRequest(request, ctx);
    }
    throw new Error(`Unknown server request: ${request.method}`);
  });
}
