import type { ServerRequest } from '../protocol/generated/index.js';
import type { ProcessingState } from '@makaio/ai-adapters-core';
import type {
  ItemCompletedNotification,
  ItemStartedNotification,
  ThreadStartedNotification,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnStartedNotification,
} from '../protocol/generated/v2/index.js';
import type { CodexAppServerBus } from '../namespaces/index.js';
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

interface NotificationHandlerOptions {
  client: JsonRpcClient;
  enqueueNotification: (handler: () => Promise<void>) => void;
  onThreadStarted: (params: ThreadStartedNotification) => Promise<void>;
  consumeTurnNumber: () => number;
  getCurrentTurn: () => CodexAppServerTurn | undefined;
  emit: CodexAppServerBus['emit'];
  commandExecutionByItemId: Map<string, { command: string; cwd: string }>;
  dynamicToolCallByItemId: Map<string, DynamicToolCallCacheEntry>;
  updateProcessingState: (state: ProcessingState) => Promise<void>;
  appendAgentMessageDelta: (delta: string) => void;
  onTurnCompleted: (params: TurnCompletedNotification) => Promise<void>;
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
  handleError: (error: unknown, terminate?: boolean) => void;
  getDisabledNativeTools: () => ReadonlySet<string>;
  handleDynamicToolCallRequest: (params: DynamicToolCallServerRequest['params']) => Promise<DynamicToolCallResponse>;
  waitForCommandInfo: ApprovalContext['waitForCommandInfo'];
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
    emit,
    commandExecutionByItemId,
    dynamicToolCallByItemId,
    updateProcessingState,
    appendAgentMessageDelta,
    onTurnCompleted,
    getThread,
    handleAsyncError,
    onCommandInfoReady,
  } = options;

  client.onNotification('thread/started', (_method, params) => {
    enqueueNotification(() => onThreadStarted(params as ThreadStartedNotification));
  });

  client.onNotification('turn/started', (_method, params) => {
    consumeTurnNumber();
    enqueueNotification(() =>
      handleTurnStarted(params as TurnStartedNotification, getCurrentTurn(), updateProcessingState),
    );
  });

  client.onNotification('item/started', (_method, params) => {
    enqueueNotification(() =>
      handleItemStarted(
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
    enqueueNotification(() =>
      handleItemCompleted(
        params as ItemCompletedNotification,
        getCurrentTurn(),
        emit,
        commandExecutionByItemId,
        dynamicToolCallByItemId,
        updateProcessingState,
      ),
    );
  });

  // Streaming deltas bypass the serialized notification queue so token/file output stays low-latency.
  // Each handler still terminates in handleAsyncError to avoid unhandled rejections on fire-and-forget paths.
  client.onNotification('item/agentMessage/delta', (_method, params) => {
    void handleAgentMessageDelta(emit, params, appendAgentMessageDelta).catch(handleAsyncError);
  });

  client.onNotification('item/commandExecution/outputDelta', (_method, params) => {
    void handleCommandOutputDelta(emit, params).catch(handleAsyncError);
  });

  client.onNotification('item/reasoning/textDelta', (_method, params) => {
    void handleReasoningDelta(emit, params).catch(handleAsyncError);
  });

  client.onNotification('item/fileChange/outputDelta', (_method, params) => {
    void handleFileChangeDelta(emit, params).catch(handleAsyncError);
  });

  client.onNotification('turn/completed', (_method, params) => {
    enqueueNotification(() => onTurnCompleted(params as TurnCompletedNotification));
  });

  client.onNotification('thread/tokenUsage/updated', (_method, params) => {
    void Promise.resolve(handleTokenUsageUpdated(params as ThreadTokenUsageUpdatedNotification, getThread())).catch(
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
