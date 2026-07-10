import type { WorkLogFrameEntry, WorkflowExecution } from '@makaio/contracts';
import type { InsertWorklogFrameEntry, SelectWorkflowExecution } from './schema.js';

/** Map a public execution value to a fully populated database row. */
export type ExecutionDbValueMapper = (execution: WorkflowExecution) => SelectWorkflowExecution;

/**
 * Compare JSON-compatible values without depending on object key order.
 * @param left - First JSON-compatible value.
 * @param right - Second JSON-compatible value.
 * @returns Whether the values are structurally equal.
 */
export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key]))
  );
}

/**
 * Convert a public WorkLog frame to nullable database values.
 * @param frame - Public WorkLog frame value.
 * @returns Database insert values.
 */
export function toFrameDbValues(frame: WorkLogFrameEntry): InsertWorklogFrameEntry {
  return {
    executionId: frame.executionId,
    frameId: frame.frameId,
    nodeId: frame.nodeId,
    nodeType: frame.nodeType,
    path: frame.path,
    status: frame.status,
    attempt: frame.attempt,
    iteration: frame.iteration ?? null,
    branchKey: frame.branchKey ?? null,
    startedAt: frame.startedAt ?? null,
    completedAt: frame.completedAt ?? null,
    durationMs: frame.durationMs ?? null,
    inputTokens: frame.inputTokens ?? null,
    outputTokens: frame.outputTokens ?? null,
    estimatedCost: frame.estimatedCost ?? null,
    error: frame.error ?? null,
  };
}
