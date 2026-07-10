/**
 * Focused mutation helpers for one in-flight execution.
 * @packageDocumentation
 */

import type { BufferedToolCall, OpenExecution, UnresolvedUsage } from './types.js';

/**
 * Build the collector key shared by buffered and unresolved tool state.
 * @param sessionId - Optional owning agent session.
 * @param toolCallId - Provider tool-call identifier.
 * @returns Stable in-memory correlation key.
 */
export function toolCorrelationKey(sessionId: string | undefined, toolCallId: string): string {
  return JSON.stringify([sessionId ?? null, toolCallId]);
}

/**
 * Append unresolved usage to an execution and assign its stable sequence.
 * @param execution - Execution receiving the usage.
 * @param usage - Usage that has now resolved to the execution.
 */
export function appendExecutionUsage(execution: OpenExecution, usage: UnresolvedUsage): void {
  execution.pendingUsage.push({ ...usage, sequence: execution.usageSequence++ });
}

/**
 * Store complete tool lifecycle state on an execution.
 * @param execution - Execution receiving the tool call.
 * @param tool - Buffered tool lifecycle state.
 */
export function bufferExecutionTool(execution: OpenExecution, tool: BufferedToolCall): void {
  execution.pendingTools.set(toolCorrelationKey(tool.sessionId, tool.toolCallId), tool);
}

/**
 * Merge a start event without weakening terminal state observed out of order.
 * @param execution - Execution receiving the start event.
 * @param tool - Normalized tool start state.
 */
export function mergeExecutionToolStart(execution: OpenExecution, tool: BufferedToolCall): void {
  const key = toolCorrelationKey(tool.sessionId, tool.toolCallId);
  const existing = execution.pendingTools.get(key);
  execution.pendingTools.set(
    key,
    existing === undefined
      ? tool
      : { ...existing, toolName: tool.toolName, startedAt: Math.min(existing.startedAt, tool.startedAt) },
  );
}

/**
 * Close a frame, creating a minimal placeholder when its start event was missed.
 * @param execution - Execution that owns the frame.
 * @param frameId - Frame identifier.
 * @param nodeId - Workflow node identifier.
 * @param endedAt - Terminal timestamp in Unix milliseconds.
 * @param status - Terminal frame status.
 * @param duration - Optional duration used to reconstruct a missing start.
 */
export function closeExecutionFrame(
  execution: OpenExecution,
  frameId: string,
  nodeId: string,
  endedAt: number,
  status: 'ok' | 'error',
  duration: number | undefined,
): void {
  const startedAt = endedAt - (duration ?? 0);
  const frame = execution.frames.get(frameId) ?? {
    frameId,
    nodeId,
    nodeType: 'unknown',
    path: [frameId],
    parentFrameId: undefined,
    startedAt,
    endedAt,
    status: 'unset' as const,
  };
  execution.frames.set(frameId, frame);
  frame.endedAt = endedAt;
  frame.status = status;
}
