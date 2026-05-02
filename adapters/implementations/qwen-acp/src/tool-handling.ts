/**
 * Tool Handling for Qwen ACP Adapter
 *
 * Centralizes tool approval transformation and bus registration for both
 * production (agent.ts) and test (createTestConfig) use cases.
 *
 * Pattern:
 * - toGlobalToolApproval: ScopedToolApprovalRequest → AgentToolApproveRequest
 * - fromGlobalToolApproval: AgentToolApproveResponse → ScopedToolApprovalResponse
 * - registerToolApprovalHandler: Wire bus handler for scoped → global routing
 * @packageDocumentation
 */

import { createToolApprovalHandler, mergeScopedToolApproval } from '@makaio/ai-adapters-core';
import type { ScopedToolApprovalRequest, ToolApprovalContext } from '@makaio/ai-adapters-core';
import type { AgentToolApproveRequest, AgentToolApproveResponse } from '@makaio/contracts';
import { QwenAcpSubjects } from './namespaces/index.js';

export type { ToolApprovalContext } from '@makaio/ai-adapters-core';

/**
 * Transform scoped ACP permission payload → AgentToolApproveRequest.
 *
 * The connector emits a `ScopedToolApprovalRequest` on the scoped bus.
 * This function merges it with agent context to produce the global request.
 * @param payload - Scoped tool approval payload from the connector bus
 * @param context - Agent context used to enrich the scoped payload
 * @returns Global tool approval request for AgentSubjects.toolApprove
 */
export function toGlobalToolApproval(
  payload: ScopedToolApprovalRequest,
  context: ToolApprovalContext,
): AgentToolApproveRequest {
  return mergeScopedToolApproval(payload, context, 'qwen-acp');
}

/**
 * Transform AgentToolApproveResponse → scoped response format.
 *
 * Qwen ACP uses the core AgentToolApproveResponse schema directly,
 * so this is an identity transformation.
 * @param response - Global tool approval response
 * @returns Scoped approval response (identical shape)
 */
export function fromGlobalToolApproval(response: AgentToolApproveResponse): AgentToolApproveResponse {
  return response;
}

/**
 * Register tool approval handler that bridges the connector's scoped
 * `permission_request` subject to the global `AgentSubjects.toolApprove` bus.
 *
 * Used by both `createTestConfig` (test harness) and `agent.ts` (production).
 */
export const registerToolApprovalHandler = createToolApprovalHandler(
  QwenAcpSubjects.permission_request,
  toGlobalToolApproval,
  fromGlobalToolApproval,
);
