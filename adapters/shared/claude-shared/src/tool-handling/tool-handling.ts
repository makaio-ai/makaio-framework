/**
 * Tool Handling for Claude Code Adapter
 *
 * Centralizes tool approval transformation and bus registration for both
 * production (agent.ts) and test (createTestConfig) use cases.
 *
 * Note: The scoped can_use_tool payload omits sessionId (the connector doesn't have it).
 * toGlobalToolApproval merges it from context (provided by the agent at request time).
 * The response transform maps core response to SDK PermissionResult format (used in connector).
 *
 * Pattern:
 * - toGlobalToolApproval: SDK payload to AgentToolApproveRequest (identity for Claude)
 * - fromGlobalToolApproval: AgentToolApproveResponse to SDK PermissionResult shape
 * - registerToolApprovalHandler: Wire bus handler for scoped to global routing
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { ClaudeConnectorNamespace } from '../namespace/index.js';
import {
  createToolApprovalHandler,
  mergeScopedToolApproval,
  type AIAgentConnector,
  type MergeScopedToolApprovalOptions,
  type ScopedToolApprovalRequest,
  type ToolApprovalContext,
} from '@makaio/ai-adapters-core';
import { AgentSubjects, type AgentToolApproveRequest, type AgentToolApproveResponse } from '@makaio/contracts';
import type { ClaudePermissionResult } from '@makaio/client-claude-code';

export type { ToolApprovalContext } from '@makaio/ai-adapters-core';
export type { ClaudePermissionResult } from '@makaio/client-claude-code';

type ToolApprovalConnector = Pick<AIAgentConnector, 'on'>;

/** Options for direct approval requests that bypass connector bus registration. */
export type ClaudeDirectApprovalRequestOptions = MergeScopedToolApprovalOptions;

/**
 * Transform scoped bus payload -\> AgentToolApproveRequest with context override.
 *
 * The scoped payload has `sessionId` optional (connector doesn't know it yet).
 * The agent always provides `sessionId` via `context`, so the result satisfies
 * the global schema which requires `sessionId`.
 * @param payload - Scoped bus can_use_tool payload (sessionId may be absent)
 * @param context - Context override providing at minimum `sessionId` for routing
 * @returns Global tool approval request with all required fields
 * @throws Error if `sessionId` is absent from context
 */
export function toGlobalToolApproval(
  payload: ScopedToolApprovalRequest,
  context: ToolApprovalContext,
): AgentToolApproveRequest {
  return mergeScopedToolApproval(payload, context, 'claude-shared');
}

/**
 * Transform AgentToolApproveResponse -\> Claude SDK PermissionResult format.
 *
 * Maps core response to SDK's behavior/message/interrupt structure.
 * Note: The actual SDK PermissionResult type is used in connector; this returns
 * a compatible shape for bus responses.
 * @param response - Global tool approval response
 * @returns SDK-compatible permission result
 */
export function fromGlobalToolApproval(response: AgentToolApproveResponse): ClaudePermissionResult {
  if (response.action === 'allow') {
    return {
      behavior: 'allow',
      updatedInput: response.updatedInput,
      updatedPermissions: response.updatedPermissions,
    };
  }

  return {
    behavior: 'deny',
    message: response.message,
    interrupt: response.shouldAbort ?? false,
  };
}

/**
 * Register tool approval handler on scoped bus.
 *
 * Wires the namespace's can_use_tool subject -\> AgentSubjects.toolApprove.
 * Used by both createTestConfig (test harness) and agent.ts (production).
 *
 * Note: Response is the raw AgentToolApproveResponse since Claude's bus schema
 * matches the core schema. The connector handles final SDK mapping.
 * @param connector - Connector for Claude Code SDK adapter
 * @param subjects - Namespace subjects providing the can_use_tool subject definition
 * @param context - Optional context override for request enrichment
 * @param globalBus - Bus that owns AgentSubjects.toolApprove handlers.
 * @returns Unsubscribe function
 */
export function registerToolApprovalHandler(
  connector: ToolApprovalConnector,
  subjects: ClaudeConnectorNamespace<string>['subjects'],
  context: ToolApprovalContext | (() => Promise<ToolApprovalContext>),
  globalBus: IMakaioBus,
): () => void {
  return createToolApprovalHandler(
    subjects.can_use_tool,
    toGlobalToolApproval,
    (response: AgentToolApproveResponse): AgentToolApproveResponse => response,
  )(connector, context, globalBus);
}

/**
 * Convenience: Request tool approval via MakaioBus (round-trip).
 *
 * For trusted call sites that need to call approval directly without bus.on() wiring.
 *
 * Accepts the scoped payload shape so callers may omit identity fields and rely on
 * explicit trusted fallback when context is unavailable.
 * @param bus - Bus that owns AgentSubjects.toolApprove handlers.
 * @param payload - Tool approval request in scoped connector format
 * @param context - Optional context override
 * @param options - Controls whether trusted callers may reuse payload session and/or identity fields
 * @returns Core tool approval response
 */
export async function requestToolApproval(
  bus: IMakaioBus,
  payload: ScopedToolApprovalRequest,
  context?: Partial<ToolApprovalContext>,
  options: ClaudeDirectApprovalRequestOptions = {},
): Promise<AgentToolApproveResponse> {
  const request = mergeScopedToolApproval(payload, context ?? {}, 'claude-shared', {
    allowPayloadSessionFallback: options.allowPayloadSessionFallback ?? false,
    allowPayloadIdentityFallback: options.allowPayloadIdentityFallback ?? false,
  });
  return bus.request(AgentSubjects.toolApprove, request);
}
