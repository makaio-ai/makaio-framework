/**
 * Approval request handlers for Codex App-Server.
 *
 * Handles command execution, file change, and dynamic tool call approval requests
 * from the server. All approval handlers gate execution through the scoped bus
 * via `requestToolApproval`, enabling a shared approval policy across adapter types.
 * @packageDocumentation
 */

import type { ServerRequest } from '../protocol/generated/index.js';
import { CodexAppServerSubjects, type CodexAppServerBus } from '../namespaces/index.js';
import {
  handleDynamicToolCall,
  isDynamicToolCallSuccess,
  type DynamicToolCallCacheEntry,
  type DynamicToolCallServerRequest,
  type DynamicToolCallResponse,
} from '../dynamic-tool-handling.js';
import type { IMakaioBus } from '@makaio/bus-core';
import type { Forbid, ForbiddenKeys, MessageHandle } from '@makaio/ai-adapters-core';
import type { CallContext } from '@makaio/contracts';
import type { ScopedSubjectDefinition } from '@makaio/core';
import type { CodexTurnEmit } from './turn-flow-handlers.js';

/** Message returned to the server when an approval request belongs to no live operation. */
const UNATTRIBUTABLE_APPROVAL_MESSAGE = 'no operation attributable to this approval request';

/**
 * Approval response returned to the server.
 */
export interface ApprovalResponse {
  decision: 'accept' | 'decline';
  message?: string;
}

/**
 * Requests tool approval over the scoped bus under the call of the operation the request belongs to.
 * @typeParam S - Approval subject definition
 */
export type CodexRequestToolApproval = <S extends ScopedSubjectDefinition<CodexAppServerBus['namespace']>>(
  call: CallContext,
  subject: S,
  payload: Forbid<S['$meta']['payload']['request'], ForbiddenKeys>,
) => Promise<S['$meta']['payload']['response']>;

/**
 * Context needed for approval handling.
 */
export interface ApprovalContext {
  agentId: string;
  cwd: string;
  commandExecutionByItemId: Map<string, { command: string; cwd: string }>;
  /** Bound requestToolApproval from AIAgentConnector. */
  requestToolApproval: CodexRequestToolApproval;
  /**
   * Returns the pending message handle that the provider turn belongs to, or `undefined` when
   * no live operation is attributable. Handlers read it synchronously, before any `await`.
   */
  handleForTurn: (turnId: string) => MessageHandle | undefined;
  handleError: (error: Error, terminate: boolean) => void;
  /**
   * Returns the set of SDK-native tool names currently disabled by the active harness.
   *
   * Evaluated lazily at each approval call so that the set reflects the state
   * resolved during {@link initializeConnection}, even though the context object
   * is constructed before the harness query runs.
   */
  getDisabledNativeTools: () => ReadonlySet<string>;
  /**
   * Waits for `item/started` to populate `commandExecutionByItemId` for the given
   * item. Returns the cached entry immediately if already present (fast path), or
   * waits up to 5 seconds for the lifecycle handler to provide it. Returns
   * `undefined` on timeout so callers can degrade gracefully.
   * @param itemId - The item ID to wait for
   */
  waitForCommandInfo: (itemId: string) => Promise<{ command: string; cwd: string } | undefined>;
}

/**
 * Handle command approval request.
 *
 * Returns an immediate `decline` when the `bash` native tool is disabled by the
 * active harness, bypassing the normal approval flow.
 * Otherwise routes the JSON-RPC server request to the scoped bus via requestToolApproval.
 * @param request - Server request for command approval
 * @param ctx - Approval context
 * @returns Approval response with decision and optional message
 */
export async function handleCommandApprovalRequest(
  request: ServerRequest,
  ctx: ApprovalContext,
): Promise<ApprovalResponse> {
  const params = request.params as {
    threadId: string;
    turnId: string;
    itemId: string;
    reason?: string | null;
    proposedExecpolicyAmendment?: unknown;
  };
  const handle = ctx.handleForTurn(params.turnId);

  if (ctx.getDisabledNativeTools().has('bash')) {
    return { decision: 'decline', message: 'bash tool is disabled by the active harness' };
  }
  if (!handle) return { decision: 'decline', message: UNATTRIBUTABLE_APPROVAL_MESSAGE };

  try {
    const commandInfo =
      ctx.commandExecutionByItemId.get(params.itemId) ?? (await ctx.waitForCommandInfo(params.itemId));
    const response = await ctx.requestToolApproval(handle.call, CodexAppServerSubjects.exec_approval_request, {
      threadId: params.threadId,
      turnId: params.turnId,
      callId: params.itemId,
      command: commandInfo ? [commandInfo.command] : ['<unknown>'],
      cwd: commandInfo?.cwd ?? ctx.cwd ?? '',
      timestamp: Date.now(),
      reason: params.reason ?? null,
    });

    return response;
  } catch (error) {
    ctx.handleError(
      new Error(`Tool approval request failed, make sure that there's a handler registered: ${String(error)}`),
      false,
    );
    return { decision: 'decline', message: String(error) };
  }
}

/**
 * Handle file change approval request.
 *
 * Returns an immediate `decline` when the `patch` native tool is disabled by the
 * active harness, bypassing the normal approval flow.
 * Otherwise routes the JSON-RPC server request to the scoped bus via requestToolApproval.
 * @param request - Server request for file change approval
 * @param ctx - Approval context
 * @returns Approval response with decision and optional message
 */
export async function handleFileChangeApprovalRequest(
  request: ServerRequest,
  ctx: ApprovalContext,
): Promise<ApprovalResponse> {
  const params = request.params as {
    threadId: string;
    turnId: string;
    itemId: string;
    reason: string | null;
    grantRoot: string | null;
  };
  const handle = ctx.handleForTurn(params.turnId);

  if (ctx.getDisabledNativeTools().has('patch')) {
    return { decision: 'decline', message: 'patch tool is disabled by the active harness' };
  }
  if (!handle) return { decision: 'decline', message: UNATTRIBUTABLE_APPROVAL_MESSAGE };

  try {
    const response = await ctx.requestToolApproval(handle.call, CodexAppServerSubjects.file_change_approval_request, {
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      reason: params.reason ?? null,
      grantRoot: params.grantRoot ?? null,
      timestamp: Date.now(),
    });

    return response;
  } catch (error) {
    ctx.handleError(
      new Error(`Tool approval request failed, make sure that there's a handler registered: ${String(error)}`),
      false,
    );
    return { decision: 'decline', message: String(error) };
  }
}

/**
 * Context needed for dynamic tool call approval and execution.
 */
export interface DynamicToolApprovalContext {
  /** Global bus that owns ToolRegistry execution handlers. */
  bus: IMakaioBus;
  /** Bound requestToolApproval from AIAgentConnector. */
  requestToolApproval: CodexRequestToolApproval;
  /**
   * Returns the pending message handle that the provider turn belongs to, or `undefined` when
   * no live operation is attributable. The handler reads it synchronously as its first statement.
   */
  handleForTurn: (turnId: string) => MessageHandle | undefined;
  /**
   * Emitter for lifecycle events, bound by the connector to the handle {@link handleForTurn} returns
   * for the same request (observer context when there is none); both are read in the same synchronous turn.
   */
  emit: CodexTurnEmit;
  /** Session ID for bus routing */
  sessionId?: string;
  /** Provider-assigned session identifier forwarded to tool execution context. */
  adapterSessionId?: string;
  /** Agent ID for attribution */
  agentId: string;
  /** Adapter instance ID for allowedAdapters policy enforcement */
  adapterId: string;
  /** Adapter type name for allowedAdapters policy enforcement */
  adapterName: string;
  /** Session tool ledger for MCP call tracking. */
  toolLedger?: import('@makaio/ai-adapters-core').ISessionToolLedger;
  /** Current turn number for MCP call tracking. */
  currentTurnNumber: number;
  /** Cache for lifecycle event correlation, keyed by itemId */
  dynamicToolCallByItemId: Map<string, DynamicToolCallCacheEntry>;
}

/**
 * Emit a synthetic begin+end lifecycle pair for a denied or errored dynamic tool call.
 *
 * Denied tool calls never produce `item/started`/`item/completed` notifications from
 * codex, so the agent's `dynamic_tool_call_begin`/`end` handlers never fire. Emitting
 * the pair here ensures downstream consumers (e.g. AgentSubjects.tool.use) observe
 * every tool call regardless of its approval outcome.
 * @param params - Tool call parameters from the server request
 * @param output - Serialised error output to surface as the tool result
 * @param emit - Emitter bound to the operation of the denied request
 */
async function emitDeniedDynamicToolCallLifecycle(
  params: DynamicToolCallServerRequest['params'],
  output: string,
  emit: CodexTurnEmit,
): Promise<void> {
  const now = Date.now();
  await emit(CodexAppServerSubjects.dynamic_tool_call_begin, {
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    name: params.name,
    args: params.arguments,
    timestamp: now,
  });
  await emit(CodexAppServerSubjects.dynamic_tool_call_end, {
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    name: params.name,
    output,
    success: false,
    timestamp: now,
  });
}

/**
 * Answer a dynamic tool call with a tool-level denial and nothing executed.
 *
 * Approval failures are tool-level, not adapter-level: the tool invocation completed
 * (with a failure result) and the agent should see it in context, so the error is
 * returned as tool output rather than routed through handleError. The synthetic
 * lifecycle is best-effort; if it fails, the denial is still returned.
 * @param params - Tool call parameters from the server request
 * @param ctx - Dynamic tool approval and execution context
 * @param errorText - Serialised error output to return as the tool result
 * @returns Content items to send back to codex
 */
async function denyDynamicToolCall(
  params: DynamicToolCallServerRequest['params'],
  ctx: DynamicToolApprovalContext,
  errorText: string,
): Promise<DynamicToolCallResponse> {
  ctx.dynamicToolCallByItemId.set(params.itemId, {
    name: params.name,
    args: params.arguments,
    output: errorText,
    success: false,
  });
  try {
    await emitDeniedDynamicToolCallLifecycle(params, errorText, ctx.emit);
  } catch {
    // Lifecycle emit failure should not block the denial response.
  } finally {
    // Clean up cache — denied/error paths emit synthetic lifecycle events, so the Codex
    // server never sends item/completed and handleItemCompleted never runs for this itemId.
    ctx.dynamicToolCallByItemId.delete(params.itemId);
  }
  return { content: [{ type: 'text', text: errorText }] };
}

/**
 * Handle an `item/tool/call` server request (experimental API).
 *
 * Requests tool approval via the scoped bus before executing. If denied, returns error
 * content without executing. If approved, executes via bus and caches result under
 * `itemId` for lifecycle handler correlation. A request that belongs to no live operation
 * is denied without an approval request.
 *
 * Denied calls emit a synthetic `dynamic_tool_call_begin`/`end` pair so that
 * downstream lifecycle consumers (e.g. `AgentSubjects.tool.use`) observe every
 * tool invocation regardless of approval outcome.
 * @param params - Parsed `item/tool/call` request parameters
 * @param ctx - Dynamic tool approval and execution context
 * @returns Content items to send back to codex
 */
export async function handleDynamicToolCallApprovalRequest(
  params: DynamicToolCallServerRequest['params'],
  ctx: DynamicToolApprovalContext,
): Promise<DynamicToolCallResponse> {
  const handle = ctx.handleForTurn(params.turnId);
  if (!handle) {
    return denyDynamicToolCall(params, ctx, JSON.stringify({ error: UNATTRIBUTABLE_APPROVAL_MESSAGE }));
  }

  let approval: ApprovalResponse;
  try {
    approval = await ctx.requestToolApproval(handle.call, CodexAppServerSubjects.dynamic_tool_call_approval_request, {
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      name: params.name,
      args: params.arguments,
      timestamp: Date.now(),
    });
  } catch (error) {
    return denyDynamicToolCall(params, ctx, JSON.stringify({ error: String(error) }));
  }

  // Fail closed: requestToolApproval crosses a bus boundary, so the runtime response
  // may not match the TypeScript type. Only an explicit 'accept' proceeds to execution.
  if (approval?.decision !== 'accept') {
    const message =
      approval?.decision === 'decline'
        ? (approval.message ?? 'Tool call denied by approval handler')
        : 'Invalid approval response from approval handler';
    return denyDynamicToolCall(params, ctx, JSON.stringify({ error: message }));
  }

  const response = await handleDynamicToolCall(handle.call, params, {
    bus: ctx.bus,
    sessionId: ctx.sessionId,
    adapterSessionId: ctx.adapterSessionId,
    agentId: ctx.agentId,
    adapterId: ctx.adapterId,
    adapterName: ctx.adapterName,
    toolLedger: ctx.toolLedger,
    currentTurnNumber: ctx.currentTurnNumber,
  });
  const outputText = response.content[0]?.text ?? '';
  // Check content presence (not text length) — an empty string is a valid tool result.
  const success = response.content.length > 0 && isDynamicToolCallSuccess(outputText);
  ctx.dynamicToolCallByItemId.set(params.itemId, {
    name: params.name,
    args: params.arguments,
    output: outputText,
    success,
  });
  return response;
}
