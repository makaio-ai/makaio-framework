/**
 * Shared tool approval transformation utilities.
 *
 * Pure functions for converting between adapter-normalized tool calls and
 * the global AgentToolApproveRequest / AgentToolApproveResponse contracts.
 * These are identical across all stream-based adapters.
 */

import type { AgentToolApproveRequest, AgentToolApproveResponse } from '@makaio/contracts';
import type { ToolApprovalContext } from '@makaio/ai-adapters-core';

import type { ToolCall } from '../namespaces/schemas/tool-calls.js';
import { type ToolCallPayload } from './tool-result.js';

export type { ToolCall };

/**
 * Runtime guard for tool-call argument payloads.
 * @param value - Parsed JSON value
 * @returns True when value is a plain object
 */
function isToolArgsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract tool-specific fields from a normalized tool call.
 *
 * The `function.arguments` field is a JSON string assembled from streaming
 * delta fragments. This function parses it to recover the structured args.
 * @param toolCall - Normalized tool call from the stream-bridge tool_calls event
 * @param adapterLabel - Short label used in error logs (e.g. 'AnthropicSdkAgent'). Defaults to 'Adapter'.
 * @returns Tool-specific payload without identity context
 */
export function extractToolCallPayload(toolCall: ToolCall, adapterLabel = 'Adapter'): ToolCallPayload {
  let parsedArgs: unknown;

  try {
    parsedArgs = JSON.parse(toolCall.function.arguments);
  } catch {
    const argsLength = toolCall.function.arguments.length;
    console.error(
      `[${adapterLabel}] Failed to parse tool arguments for "${toolCall.function.name}" (argsLength=${argsLength})`,
    );
    throw new Error(`Failed to parse tool arguments for "${toolCall.function.name}"`);
  }

  if (!isToolArgsRecord(parsedArgs)) {
    const parsedType = parsedArgs === null ? 'null' : Array.isArray(parsedArgs) ? 'array' : typeof parsedArgs;
    console.error(
      `[${adapterLabel}] Parsed tool arguments for "${toolCall.function.name}" must be a JSON object (received ${parsedType})`,
      parsedArgs,
    );
    throw new Error(`Tool arguments for "${toolCall.function.name}" must be a JSON object`);
  }

  return {
    toolName: toolCall.function.name,
    args: parsedArgs,
    toolCallId: toolCall.id,
  };
}

/**
 * Transform a normalized tool call into an AgentToolApproveRequest.
 *
 * Combines the extracted tool payload with full adapter identity context.
 * @param toolCall - Normalized tool call from the stream-bridge tool_calls event
 * @param context - Adapter context providing identity fields
 * @param adapterLabel - Short label used in error logs (e.g. 'AnthropicSdkAgent'). Defaults to 'Adapter'.
 * @returns Global tool approval request ready for AgentSubjects.toolApprove
 */
export function toGlobalToolApproval(
  toolCall: ToolCall,
  context: ToolApprovalContext,
  adapterLabel = 'Adapter',
): AgentToolApproveRequest {
  return {
    ...extractToolCallPayload(toolCall, adapterLabel),
    agentId: context.agentId,
    adapterId: context.adapterId,
    adapterName: context.adapterName,
    adapterSessionId: context.adapterSessionId,
    sessionId: context.sessionId,
  };
}

/**
 * Apply approved argument overrides directly to the tool call payload.
 *
 * Approval handlers can transform tool input via `updatedInput`. When present,
 * the modified args must replace the original JSON string before execution.
 * @param toolCall - Tool call object to update in place
 * @param approval - Allow-branch approval response from AgentSubjects.toolApprove
 */
export function applyApprovedArgs(
  toolCall: ToolCall,
  approval: Extract<AgentToolApproveResponse, { action: 'allow' }>,
): void {
  if (approval.updatedInput === undefined) {
    return;
  }
  toolCall.function.arguments = JSON.stringify(approval.updatedInput);
}
