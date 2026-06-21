/**
 * Shared tool-call orchestration for stream-based adapters.
 *
 * Generic over the SDK-specific result type so each adapter can format
 * results in its own wire format while sharing approval and execution logic.
 */

import type { AgentToolApproveResponse } from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';
import { isMcpCallTool, extractMcpCallTarget } from '@makaio/ai-adapters-core';

import type { ToolCall } from '../namespaces/schemas/tool-calls.js';
import { extractToolCallPayload, applyApprovedArgs } from './tool-approval.js';
import { executeTool, type ToolLifecycleEmitter } from './tool-execution.js';
import { boundToolResultContent, type ToolCallPayload, type ToolExecutionContextOverrides } from './tool-result.js';

/**
 * Callbacks needed by {@link handleToolCalls}. Adapter-agnostic.
 */
export type HandleToolCallsCallbacks = {
  /** Host bus used for cross-namespace tool execution. */
  bus: IMakaioBus;
  /** Emit SDK lifecycle events (tool_started, tool_completed). */
  emitSdkEvent: ToolLifecycleEmitter;
  /**
   * Request tool approval via the scoped bus routed to the global bus.
   * @param payload - Tool call payload enriched with optional reasoning
   * @returns Global approval response
   */
  requestToolApproval: (payload: ToolCallPayload & { reasoning?: string }) => Promise<AgentToolApproveResponse>;
  /**
   * Record an mcp_call invocation in the session tool ledger.
   *
   * Optional. When present, called after each successful mcp_call execution
   * with the resolved target tool name. The connector binds this callback to
   * its ledger and captures the current turn number in the closure, so it
   * always reflects the turn in progress when the call is recorded.
   * @param toolFullName - Namespaced target tool name extracted from mcp_call args
   */
  recordMcpCall?: (toolFullName: string) => void;
};

/**
 * Adapter-specific result formatter for tool call outcomes.
 * @param toolCallId - The tool call ID for correlation
 * @param content - Serialized result content (already bounded)
 * @param isError - Whether the result represents an error
 * @returns SDK-specific result value
 */
export type ToolResultBuilder<TResult> = (toolCallId: string, content: string, isError: boolean) => TResult;

/**
 * Process tool calls from a model response: approve, execute, and format results.
 *
 * Shared orchestration across all stream-based adapters. Each adapter provides
 * a `buildResult` factory to format results in its SDK-specific type.
 *
 * **Mutation:** When approval modifies tool arguments, entries in `toolCalls`
 * are mutated in place via {@link applyApprovedArgs}.
 * @param toolCalls - Tool calls from the model (entries may be mutated when approval modifies args)
 * @param callbacks - Approval and lifecycle event callbacks
 * @param contextOverrides - Execution context (session, agent, turn)
 * @param buildResult - Adapter-specific result formatter
 * @param adapterLabel - Adapter name for logging
 * @returns Formatted tool results for injection back into the conversation
 */
export async function handleToolCalls<TResult>(
  toolCalls: ToolCall[],
  callbacks: HandleToolCallsCallbacks,
  contextOverrides: ToolExecutionContextOverrides,
  buildResult: ToolResultBuilder<TResult>,
  adapterLabel: string,
): Promise<TResult[]> {
  const results: TResult[] = [];

  for (const toolCall of toolCalls) {
    const payload = extractToolCallPayload(toolCall, adapterLabel);
    const approval = await callbacks.requestToolApproval({
      ...payload,
      reasoning: contextOverrides.reasoning,
    });

    if (approval.action === 'deny') {
      // Hard denial (shouldAbort: true) throws to trigger error flow.
      // Soft denial (shouldAbort: false) pushes error result and continues.
      // approval.message is always a string here — the AgentToolApproveSchema
      // deny branch defines message: z.string() (required, not optional).
      if (approval.shouldAbort) {
        throw new Error(`Tool use denied by approval handler: ${toolCall.function.name}`);
      }
      const denialContent = boundToolResultContent(
        JSON.stringify({
          error: approval.message,
        }),
      );
      results.push(buildResult(toolCall.id, denialContent, true));
      continue;
    }

    applyApprovedArgs(toolCall, approval);
    const executionResult = await executeTool(callbacks.bus, toolCall, callbacks.emitSdkEvent, contextOverrides);

    if (executionResult.success) {
      // Record mcp_call invocations in the session tool ledger after successful
      // execution. Uses post-approval args (approval.updatedInput ?? payload.args)
      // so that when an approval handler rewrites the `tool` field, the ledger
      // records the target the model actually called, not the pre-approval snapshot.
      if (callbacks.recordMcpCall && isMcpCallTool(payload.toolName)) {
        const targetTool = extractMcpCallTarget(approval.updatedInput ?? payload.args);
        if (targetTool !== undefined) {
          callbacks.recordMcpCall(targetTool);
        }
      }
    }

    const content = executionResult.success
      ? typeof executionResult.data === 'string'
        ? executionResult.data
        : JSON.stringify(executionResult.data ?? null)
      : JSON.stringify({ error: executionResult.error.message, code: executionResult.error.code });
    results.push(buildResult(toolCall.id, boundToolResultContent(content), !executionResult.success));
  }

  return results;
}
