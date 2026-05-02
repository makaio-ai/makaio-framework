/**
 * Tool Handling for Codex App-Server Adapter
 *
 * Centralizes tool approval transformation and bus registration for both
 * production (agent.ts) and test (createTestConfig) use cases.
 *
 * Pattern:
 * - toGlobalToolApproval: Command approval → AgentToolApproveRequest
 * - toGlobalFileApproval: File change approval → AgentToolApproveRequest
 * - fromGlobalToolApproval: AgentToolApproveResponse → App-server decision
 * - registerToolApprovalHandler: Wire bus handler for scoped → global routing
 * @packageDocumentation
 */

import type { AgentToolApproveRequest, AgentToolApproveResponse } from '@makaio/contracts';
import { AgentSubjects } from '@makaio/contracts';
import { AIAgentConnector } from '@makaio/ai-adapters-core';
import type { ToolApprovalContext } from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import type {
  CommandExecutionRequestApprovalParams,
  FileChangeRequestApprovalParams,
} from './protocol/generated/v2/index.js';
import { CodexAppServerSubjects } from './namespaces/index.js';

/** Decision format expected by Codex app-server */
export type CodexToolApprovalDecision = 'accept' | 'decline';
export type { ToolApprovalContext } from '@makaio/ai-adapters-core';

/** App-server approval decision with optional message */
export type CodexToolApprovalResponse = {
  decision: CodexToolApprovalDecision;
  message?: string;
};

/**
 * Minimal shape of connector request contexts used for approval handling.
 */
type ApprovalRequestContext<TPayload> = {
  payload: TPayload;
  setResult: (result: CodexToolApprovalResponse) => void;
};

const TOOL_APPROVAL_DEBUG_ENABLED =
  process.env.MAKAIO_DEBUG_TOOL_APPROVAL === '1' || process.env.DEBUG?.includes('codex-tool-approval') === true;

/**
 * Debug logger for tool-approval bridge flow.
 * @param message - Message to log
 * @param context - Optional structured context
 */
function logToolApprovalDebug(message: string, context?: Record<string, unknown>): void {
  if (!TOOL_APPROVAL_DEBUG_ENABLED) return;
  console.debug('[registerToolApprovalHandler]', message, context ?? {});
}

/**
 * Build the shared approval envelope fields from adapter context.
 * @param context - Adapter context
 * @returns Shared approval envelope fields
 */
function createApprovalEnvelope(
  context: ToolApprovalContext,
): Pick<AgentToolApproveRequest, 'adapterId' | 'adapterName' | 'agentId' | 'adapterSessionId' | 'sessionId'> {
  return {
    adapterId: context.adapterId,
    adapterName: context.adapterName,
    agentId: context.agentId,
    adapterSessionId: context.adapterSessionId,
    sessionId: context.sessionId,
  };
}

/**
 * Transform command execution approval request → AgentToolApproveRequest.
 *
 * Converts the app-server's command execution approval params into the global
 * tool approval request format. The params are included as args for context.
 * @param params - Raw app-server approval request parameters
 * @param context - Adapter context for request enrichment
 * @returns Global tool approval request
 */
export function toGlobalToolApproval(
  params: CommandExecutionRequestApprovalParams,
  context: ToolApprovalContext,
): AgentToolApproveRequest {
  return {
    ...createApprovalEnvelope(context),
    toolCallId: params.itemId,
    toolName: 'bash',
    reasoning: params.reason ?? undefined,
    args: {
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      reason: params.reason,
      proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
    },
  };
}

/**
 * Transform file change approval request → AgentToolApproveRequest.
 *
 * Converts the app-server's file change approval params into the global
 * tool approval request format. The params are included as args for context.
 * @param params - Raw app-server approval request parameters
 * @param context - Adapter context for request enrichment
 * @returns Global tool approval request
 */
export function toGlobalFileApproval(
  params: FileChangeRequestApprovalParams,
  context: ToolApprovalContext,
): AgentToolApproveRequest {
  return {
    ...createApprovalEnvelope(context),
    toolCallId: params.itemId,
    toolName: 'patch',
    reasoning: params.reason ?? undefined,
    args: {
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      reason: params.reason,
      grantRoot: params.grantRoot,
    },
  };
}

/**
 * Transform AgentToolApproveResponse → app-server decision format.
 *
 * Converts the global approval response into the simple accept/decline format
 * expected by the codex app-server protocol.
 * @param response - Global tool approval response
 * @returns App-server approval decision with optional message
 */
export function fromGlobalToolApproval(response: AgentToolApproveResponse): CodexToolApprovalResponse {
  if (response.action === 'allow') {
    return { decision: 'accept' };
  }

  // Denied - include message if provided
  return {
    decision: 'decline',
    message: response.message || undefined,
  };
}

/**
 * Register tool approval handler that bridges connector's approval requests
 * to the global AgentSubjects.toolApprove bus.
 *
 * Wires:
 * - CodexAppServerSubjects.exec_approval_request → AgentSubjects.toolApprove
 * - CodexAppServerSubjects.file_change_approval_request → AgentSubjects.toolApprove
 *
 * Used by both createTestConfig (test harness) and agent.ts (production).
 * @param connector - Connector for Codex App-Server adapter (needs `on` and `getTimeoutMs` methods)
 * @param context - Adapter context (can be lazy callback)
 * @returns Unsubscribe function that removes both handlers
 */
export function registerToolApprovalHandler(
  connector: AIAgentConnector,
  context: ToolApprovalContext | (() => Promise<ToolApprovalContext>),
): () => void {
  // Use connector's configured timeout (must be shorter than JSON-RPC server's request timeout)
  const timeout = connector.getTimeoutMs('toolApproval');

  /**
   * Resolve adapter context lazily (callback avoids race condition with adapterSessionId)
   * @returns Resolved ToolApprovalContext
   */
  const resolveContext = async (): Promise<ToolApprovalContext> => {
    const providedContext = typeof context === 'function' ? await context() : context;
    if (
      providedContext == null ||
      typeof providedContext !== 'object' ||
      typeof providedContext.sessionId !== 'string'
    ) {
      throw new Error('Tool approval requires a sessionId — ensure the agent was created within a session');
    }
    const sessionId = providedContext.sessionId.trim();
    if (sessionId === '') {
      throw new Error('Tool approval requires a sessionId — ensure the agent was created within a session');
    }
    return {
      adapterId: providedContext?.adapterId ?? connector.adapterId,
      adapterName: providedContext?.adapterName ?? connector.getAdapterName(),
      agentId: providedContext?.agentId ?? connector.getAgentId(),
      adapterSessionId: providedContext?.adapterSessionId ?? (await connector.getAdapterSessionId()),
      sessionId,
    };
  };

  /**
   * Bridge a connector approval request to the global approval bus.
   * @param ctx - Connector request context
   * @param transform - Payload-to-global-request transformer
   * @param logTag - Optional debug label
   */
  const handleApprovalRequest = async <TPayload>(
    ctx: ApprovalRequestContext<TPayload>,
    transform: (payload: TPayload, resolvedContext: ToolApprovalContext) => AgentToolApproveRequest,
    logTag?: string,
  ): Promise<void> => {
    if (logTag) {
      logToolApprovalDebug(`${logTag} invoked`, { timestamp: Date.now() });
    }

    let globalResponse: AgentToolApproveResponse;
    try {
      const resolvedContext = await resolveContext();
      if (logTag) {
        logToolApprovalDebug('resolved context', { agentId: resolvedContext.agentId, timestamp: Date.now() });
      }

      const request = transform(ctx.payload, resolvedContext);
      if (logTag) {
        logToolApprovalDebug('requesting global approval', { agentId: request.agentId, timestamp: Date.now() });
      }

      globalResponse = await MakaioBus.request(AgentSubjects.toolApprove, request, { timeout });
    } catch (error) {
      console.error('[registerToolApprovalHandler] Tool approval request failed:', error);
      const errorDetails = error instanceof Error ? `: ${error.message}` : '';
      ctx.setResult({ decision: 'decline', message: `Tool approval request failed${errorDetails}` });
      return;
    }

    if (logTag) {
      logToolApprovalDebug('received global approval response', {
        action: globalResponse.action,
        timestamp: Date.now(),
      });
    }

    // INTENTIONAL: throw outside try/catch so shouldAbort propagates to the connector
    if (globalResponse.action === 'deny' && globalResponse.shouldAbort) {
      throw new Error(`Tool use denied by approval handler: ${globalResponse.message ?? 'access denied'}`);
    }

    ctx.setResult(fromGlobalToolApproval(globalResponse));
  };

  // Subscribe to command execution approval requests
  const unsubExec = connector.on(CodexAppServerSubjects.exec_approval_request, async (ctx) => {
    await handleApprovalRequest(ctx, toGlobalToolApprovalFromInternal, 'exec_approval_request');
  });

  // Subscribe to file change approval requests
  const unsubFile = connector.on(CodexAppServerSubjects.file_change_approval_request, async (ctx) => {
    await handleApprovalRequest(ctx, toGlobalFileApprovalFromInternal, 'file_change_approval_request');
  });

  // Return composite unsubscribe function
  return () => {
    unsubExec();
    unsubFile();
  };
}

/**
 * Transform internal scoped bus exec approval payload → AgentToolApproveRequest.
 *
 * Similar to toGlobalToolApproval but works with the internal scoped bus payload
 * which has a slightly different shape (callId vs itemId).
 * @param payload - Internal scoped bus payload with threadId, turnId, callId, command, cwd
 * @param context - Adapter context for request enrichment
 * @returns Global tool approval request
 */
function toGlobalToolApprovalFromInternal(
  payload: {
    threadId: string;
    turnId: string;
    callId: string;
    command: string[];
    cwd: string;
    reason: string | null;
    timestamp: number;
  },
  context: ToolApprovalContext,
): AgentToolApproveRequest {
  return {
    ...createApprovalEnvelope(context),
    toolCallId: payload.callId,
    toolName: 'bash',
    // Internal command-approval events expose `reason` (not `reasoning`); map it into
    // the shared `reasoning` field to keep approval payloads consistent.
    reasoning: payload.reason ?? undefined,
    args: {
      threadId: payload.threadId,
      turnId: payload.turnId,
      callId: payload.callId,
      command: payload.command,
      cwd: payload.cwd,
      reason: payload.reason,
    },
  };
}

/**
 * Transform internal scoped bus file approval payload → AgentToolApproveRequest.
 *
 * Similar to toGlobalFileApproval but works with the internal scoped bus payload
 * which has a slightly different shape (itemId vs callId).
 * @param payload - Internal scoped bus payload with threadId, turnId, itemId, reason, grantRoot
 * @param context - Adapter context for request enrichment
 * @returns Global tool approval request
 */
function toGlobalFileApprovalFromInternal(
  payload: {
    threadId: string;
    turnId: string;
    itemId: string;
    reason: string | null;
    grantRoot: string | null;
    timestamp: number;
  },
  context: ToolApprovalContext,
): AgentToolApproveRequest {
  return {
    ...createApprovalEnvelope(context),
    toolCallId: payload.itemId,
    toolName: 'patch',
    // Internal file-change events expose `reason` (not `reasoning`); map it into
    // the shared `reasoning` field to keep approval payloads consistent.
    reasoning: payload.reason ?? undefined,
    args: {
      threadId: payload.threadId,
      turnId: payload.turnId,
      itemId: payload.itemId,
      reason: payload.reason,
      grantRoot: payload.grantRoot,
    },
  };
}
