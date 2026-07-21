import type { IMakaioBus } from '@makaio/bus-core';
import {
  SubagentSubjects,
  SubagentError,
  SubagentErrorCode,
  type SubagentStatus,
  type SpawnSubagentRpcRequest,
  type SpawnSubagentRpcResponse,
  type AwaitSubagentRequest,
  type AwaitSubagentResponse,
  type SendToSubagentRequest,
  type SendToSubagentResponse,
  type KillSubagentRequest,
  type KillSubagentResponse,
  type ReportProgressRequest,
  type ReportProgressResponse,
  type RequestInputRpcRequest,
  type RequestInputRpcResponse,
  type CompleteTaskRequest,
  type CompleteTaskResponse,
  type ListSubagentsBySessionRequest,
  type ListSubagentsBySessionResponse,
} from '@makaio/contracts';
import type { SubagentManager } from './manager/index.js';
import type { AwaitResult } from './manager/types.js';
import { resolveInheritedAdapterName } from './resolve-inherited-adapter.js';

/**
 * RPC handler context providing access to manager and bus.
 */
export interface RpcHandlerContext {
  manager: SubagentManager;
  bus: IMakaioBus;
  executionOwnerId?: string;
  onCompletionCandidate?: (subagentId: string) => Promise<void>;
}

interface GetStatusResponse {
  status: SubagentStatus;
  childSessionId?: string;
  pendingRequest?: { messageId: string; question: string; context?: string };
  progress: string[];
  result?: string;
  summary?: string;
  error?: string;
  usage?: AwaitSubagentResponse['usage'];
}

/**
 * Handle getStatus RPC - queries current subagent state.
 * @param ctx - Handler context with manager and bus
 * @param payload - Request with subagentId
 * @returns Status response with current state
 */
export function handleGetStatusRpc(ctx: RpcHandlerContext, payload: { subagentId: string }): GetStatusResponse {
  const subagent = ctx.manager.get(payload.subagentId);

  if (!subagent) {
    throw new Error(`Subagent not found: ${payload.subagentId}`);
  }

  return {
    status: subagent.status,
    childSessionId: subagent.childSessionId,
    pendingRequest: subagent.pendingRequest
      ? {
          messageId: subagent.pendingRequest.messageId,
          question: subagent.pendingRequest.question,
          context: subagent.pendingRequest.context,
        }
      : undefined,
    progress: subagent.progressUpdates.toArray(),
    result: subagent.result,
    summary: subagent.summary,
    error: subagent.error,
    usage: subagent.usage,
  };
}

/**
 * Handle spawn RPC - validates constraints, tracks subagent, emits spawned event.
 * @param ctx - Handler context with manager and bus
 * @param payload - Spawn request with parentSessionId, config, depth
 * @returns Spawn response with subagentId and status
 */
export async function handleSpawnRpc(
  ctx: RpcHandlerContext,
  payload: SpawnSubagentRpcRequest,
): Promise<SpawnSubagentRpcResponse> {
  const { parentSessionId, config, depth, spawningToolCallId } = payload;
  const { constraints } = ctx.manager;

  const effectiveMaxDepth = Math.min(config.maxDepth ?? constraints.maxDepth, constraints.maxDepth);
  if (depth > effectiveMaxDepth) {
    throw new SubagentError(SubagentErrorCode.DEPTH_EXCEEDED, `Maximum subagent depth (${effectiveMaxDepth}) exceeded`);
  }

  if (ctx.manager.countActiveBySession(parentSessionId) >= constraints.maxConcurrentPerSession) {
    throw new SubagentError(
      SubagentErrorCode.SESSION_LIMIT,
      `Maximum concurrent subagents per session (${constraints.maxConcurrentPerSession}) reached`,
    );
  }

  if (ctx.manager.countTotalActive() >= constraints.maxTotalActive) {
    throw new SubagentError(
      SubagentErrorCode.GLOBAL_LIMIT,
      `Maximum total active subagents (${constraints.maxTotalActive}) reached`,
    );
  }

  const adapterName = await resolveInheritedAdapterName(ctx.bus, parentSessionId, config.adapterName);

  if (!adapterName) {
    throw new SubagentError(
      SubagentErrorCode.ADAPTER_NOT_ALLOWED,
      'adapterName is required for subagent spawn when parent session has no inheritable adapter',
    );
  }

  if (constraints.allowedAdapters.length > 0) {
    if (!constraints.allowedAdapters.includes(adapterName)) {
      throw new SubagentError(SubagentErrorCode.ADAPTER_NOT_ALLOWED, `Adapter '${adapterName}' is not allowed`);
    }
  }
  if (config.model && constraints.allowedModels.length > 0 && !constraints.allowedModels.includes(config.model)) {
    throw new SubagentError(SubagentErrorCode.MODEL_NOT_ALLOWED, `Model '${config.model}' is not allowed`);
  }
  const normalizedConfig = {
    ...config,
    adapterName,
  };

  const subagentId = crypto.randomUUID();
  ctx.manager.track({
    subagentId,
    parentSessionId,
    config: normalizedConfig,
    depth,
  });

  await ctx.bus.emit(SubagentSubjects.spawned, {
    subagentId,
    parentSessionId,
    task: normalizedConfig.task,
    config: normalizedConfig,
    depth,
    ...(ctx.executionOwnerId !== undefined && { executionOwnerId: ctx.executionOwnerId }),
    ...(spawningToolCallId !== undefined && { spawningToolCallId }),
  });

  return {
    subagentId,
    status: 'spawning',
  };
}

/**
 * Handle await RPC - waits for subagent to reach terminal state.
 * @param ctx - Handler context with manager and bus
 * @param payload - Await request with subagentId and optional timeout
 * @returns Await response with final status and result/error
 */
export async function handleAwaitRpc(
  ctx: RpcHandlerContext,
  payload: AwaitSubagentRequest,
): Promise<AwaitSubagentResponse> {
  const { subagentId, timeoutMs } = payload;
  const subagent = ctx.manager.get(subagentId);

  if (!subagent) {
    throw new Error(`Subagent not found: ${subagentId}`);
  }
  const terminalStates = ['completed', 'failed', 'cancelled'] as const;
  if (terminalStates.includes(subagent.status as (typeof terminalStates)[number])) {
    return {
      status: subagent.status as AwaitSubagentResponse['status'],
      result: subagent.result,
      error: subagent.error,
      completionSource: subagent.completionSource,
      toolObservations: [...subagent.toolObservations],
      usage: subagent.usage,
    };
  }

  if (subagent.status === 'waiting_input' && subagent.pendingRequest) {
    return {
      status: 'waiting_input',
      pendingRequest: {
        messageId: subagent.pendingRequest.messageId,
        question: subagent.pendingRequest.question,
        context: subagent.pendingRequest.context,
      },
    };
  }

  // Wait for terminal state
  const timeout = timeoutMs ?? ctx.manager.constraints.defaultAwaitTimeoutMs;
  return new Promise<AwaitSubagentResponse>((resolve) => {
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const awaiterCallback = (result: AwaitResult) => {
      if (resolved) return;
      resolved = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolve({
        status: result.status,
        result: result.result,
        error: result.error,
        pendingRequest: result.pendingRequest,
        completionSource: result.completionSource,
        toolObservations: result.toolObservations,
        usage: result.usage,
      });
    };

    ctx.manager.addAwaiter(subagentId, awaiterCallback);

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        // Clean up the awaiter to prevent memory leak
        ctx.manager.removeAwaiter(subagentId, awaiterCallback);
        resolve({ status: 'timeout' });
      }, timeout);
    }
  });
}

/**
 * Handle send RPC - sends message to subagent.
 * @param ctx - Handler context with manager and bus
 * @param payload - Send request with subagentId, content, optional inResponseTo
 * @returns Send response indicating success
 */
export async function handleSendRpc(
  ctx: RpcHandlerContext,
  payload: SendToSubagentRequest,
): Promise<SendToSubagentResponse> {
  const { subagentId, content, inResponseTo } = payload;
  const subagent = ctx.manager.get(subagentId);

  if (!subagent) {
    throw new Error(`Subagent not found: ${subagentId}`);
  }
  if (subagent.status === 'spawning') {
    throw new SubagentError(SubagentErrorCode.INVALID_STATE, 'Cannot send to a subagent before startup completes');
  }
  // Completion intent, not its display status, closes child message admission.
  // A stalled candidate may be surfaced as `hung` while remaining immutable.
  if (subagent.completionCandidate !== undefined) {
    throw new SubagentError(SubagentErrorCode.INVALID_STATE, 'Cannot send to a subagent while completion is pending');
  }

  let resolvedPending = false;
  if (inResponseTo && subagent.pendingRequest?.messageId === inResponseTo) {
    ctx.manager.resolvePendingRequest(subagentId, content);
    resolvedPending = true;
  }

  // Emit toChild for message routing
  await ctx.bus.emit(SubagentSubjects.toChild, {
    subagentId,
    messageId: crypto.randomUUID(),
    content,
    inResponseTo,
  });

  return { sent: true, resolvedPending };
}

/**
 * Handle kill RPC - terminates a running subagent.
 * @param ctx - Handler context with manager and bus
 * @param payload - Kill request with subagentId
 * @returns Kill response indicating success
 */
export async function handleKillRpc(
  ctx: RpcHandlerContext,
  payload: KillSubagentRequest,
): Promise<KillSubagentResponse> {
  const { subagentId, reason } = payload;
  const killed = ctx.manager.markCancelled(subagentId);

  if (killed) {
    await ctx.bus.emit(SubagentSubjects.cancelled, {
      subagentId,
      reason: reason ?? 'Killed by parent',
    });
  }

  return { killed };
}

/**
 * Handle reportProgress RPC - child reports progress update.
 * @param ctx - Handler context with manager and bus
 * @param payload - Progress report with subagentId, update, optional percentComplete
 * @returns Response indicating success
 */
export async function handleReportProgressRpc(
  ctx: RpcHandlerContext,
  payload: ReportProgressRequest,
): Promise<ReportProgressResponse> {
  const { subagentId, update, percentComplete } = payload;
  const subagent = ctx.manager.get(subagentId);

  if (!subagent) {
    throw new Error(`Subagent not found: ${subagentId}`);
  }

  // Format progress with percentage if provided
  const formattedUpdate = percentComplete !== undefined ? `[${percentComplete}%] ${update}` : update;
  ctx.manager.addProgress(subagentId, formattedUpdate);

  // Emit progress event for parent to observe
  await ctx.bus.emit(SubagentSubjects.toParent, {
    subagentId,
    messageId: crypto.randomUUID(),
    type: 'progress' as const,
    content: formattedUpdate,
  });

  return { reported: true };
}

/**
 * Handle requestInput RPC - child requests input from parent.
 * Blocks until parent responds or timeout.
 * @param ctx - Handler context with manager and bus
 * @param payload - Input request with subagentId, question, optional context and timeout
 * @returns Response with parent's answer or timeout indicator
 */
export async function handleRequestInputRpc(
  ctx: RpcHandlerContext,
  payload: RequestInputRpcRequest,
): Promise<RequestInputRpcResponse> {
  const { subagentId, question, context, timeoutMs } = payload;
  const subagent = ctx.manager.get(subagentId);

  if (!subagent) {
    throw new Error(`Subagent not found: ${subagentId}`);
  }
  if (subagent.completionCandidate !== undefined) {
    throw new SubagentError(SubagentErrorCode.INVALID_STATE, 'Cannot request input while completion is pending');
  }

  const messageId = crypto.randomUUID();
  const timeout = timeoutMs ?? ctx.manager.constraints.defaultRequestTimeoutMs;
  let resolved = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let resolveResponse!: (response: RequestInputRpcResponse) => void;
  const responsePromise = new Promise<RequestInputRpcResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const resolver = (response: string | null) => {
    if (resolved) return;
    resolved = true;
    if (timeoutId) clearTimeout(timeoutId);

    if (response === null) {
      resolveResponse({ responded: false, timedOut: true });
    } else {
      resolveResponse({ responded: true, response, timedOut: false });
    }
  };

  // Claim waiting_input before publication so completion and input requests
  // arbitrate synchronously in the manager.
  ctx.manager.setPendingRequest(subagentId, { messageId, question, context, resolver });
  if (timeout > 0) {
    timeoutId = setTimeout(() => {
      if (resolved) return;
      ctx.manager.resolvePendingRequest(subagentId, null);
    }, timeout);
  }
  const publication = ctx.bus
    .emit(SubagentSubjects.toParent, {
      subagentId,
      messageId,
      type: 'request_input' as const,
      content: question,
      context,
    })
    .then(
      () => ({ published: true }) as const,
      (error: unknown) => ({ published: false, error }) as const,
    );
  const first = await Promise.race([responsePromise.then((response) => ({ response }) as const), publication]);
  if ('response' in first) return first.response;
  if (!first.published) {
    ctx.manager.resolvePendingRequest(subagentId, null);
    throw first.error;
  }

  return responsePromise;
}

/**
 * Handle completeTask RPC - child signals task completion.
 * @param ctx - Handler context with manager and bus
 * @param payload - Completion with managed child session, optional turn hint, result, and optional summary
 * @returns Response indicating success
 */
export async function handleCompleteTaskRpc(
  ctx: RpcHandlerContext,
  payload: CompleteTaskRequest,
): Promise<CompleteTaskResponse> {
  const { sessionId, turnId, result, summary } = payload;
  const subagent = ctx.manager.getByChildSessionId(sessionId);
  if (subagent === undefined)
    throw new SubagentError(SubagentErrorCode.NOT_FOUND, 'No subagent owns this child session');
  if (subagent.status === 'completed' || subagent.status === 'failed' || subagent.status === 'cancelled') {
    throw new SubagentError(
      SubagentErrorCode.ALREADY_TERMINAL,
      `Subagent already in terminal state: ${subagent.status}`,
    );
  }
  const activeTurnId = subagent.activeTurnId;
  if (activeTurnId === undefined) {
    throw new SubagentError(SubagentErrorCode.INVALID_STATE, 'No active turn exists for this child session');
  }
  if (turnId !== undefined && turnId !== activeTurnId) {
    throw new SubagentError(SubagentErrorCode.INVALID_STATE, 'Completion turn does not match the active child turn');
  }
  ctx.manager.recordCompletionCandidate(subagent.subagentId, activeTurnId, result, summary, 'tool');
  await ctx.onCompletionCandidate?.(subagent.subagentId);

  return { completed: true };
}

/**
 * Handle listBySession RPC - returns non-terminal subagents for a parent session.
 *
 * Only non-terminal subagents are included (status not in completed/failed/cancelled).
 * Because tracking is in-memory only, this list will be empty after a process
 * restart — subagents re-appear as they report back via status events.
 * @param ctx - Handler context with manager and bus
 * @param payload - Request containing the parent session ID
 * @returns Condensed subagent summaries for the given parent session
 */
export function handleListBySessionRpc(
  ctx: RpcHandlerContext,
  payload: ListSubagentsBySessionRequest,
): ListSubagentsBySessionResponse {
  const { parentSessionId } = payload;
  const subagents = ctx.manager
    .getAllNonTerminal()
    .filter((s) => s.parentSessionId === parentSessionId)
    .map((s) => ({
      subagentId: s.subagentId,
      task: s.config.task,
      status: s.status,
    }));

  return { subagents };
}
