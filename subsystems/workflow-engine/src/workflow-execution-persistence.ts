import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/core';
import type { ExecutionStatus, WorkflowExecution } from '@makaio/contracts';
import { WorkflowStorageSubjects } from './storage/namespace.js';

/** Execution-level fields that can change after the initial execution insert. */
export interface ExecutionMetadataPatch {
  /** Current execution status. */
  status?: ExecutionStatus;
  /** Terminal execution error, or `null` to clear it. */
  error?: string | null;
  /** Terminal cancellation reason, or `null` to clear it. */
  reason?: string | null;
  /** Terminal completion timestamp, or `null` to clear it. */
  completedAt?: number | null;
}

/**
 * Persist a metadata patch for one workflow execution.
 * @param call - Call context of the handled message the update serves.
 * @param bus - Message bus used for storage writes.
 * @param execution - Mutable in-memory execution state (used for the execution ID).
 * @param patch - Metadata fields to persist.
 */
export async function persistExecutionUpdate(
  call: CallContext,
  bus: IMakaioBus,
  execution: WorkflowExecution,
  patch: ExecutionMetadataPatch,
): Promise<void> {
  const result = await bus.request(call, WorkflowStorageSubjects.updateExecution, {
    executionId: execution.id,
    status: patch.status,
    error: patch.error,
    reason: patch.reason,
    completedAt: patch.completedAt,
  });

  if (!result.success) {
    throw new Error(`Workflow execution not found: ${execution.id}`);
  }
}
