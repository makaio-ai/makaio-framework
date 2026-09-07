import type { WorkflowExecution } from '@makaio/contracts';
import type { WorkflowAttemptCancellation } from './workflow-attempt-outcome.js';
import { cancelExecution, type FinalizerDeps } from './workflow-execution-finalizer.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';

/**
 * Converge an already-committed cooperative cancellation through the owner lifecycle.
 * The Attempt reports that work has stopped; this is not another Worker cancel request.
 * @param deps - Existing executor lifecycle and resource-cleanup dependencies.
 * @param executionId - Durable authority-owned workflow execution.
 * @param cancellation - Canonical cancellation retained in Attempt storage.
 * @returns The durable owner status after idempotent convergence.
 */
export async function acceptWorkflowCancellation(
  deps: FinalizerDeps,
  executionId: string,
  cancellation: WorkflowAttemptCancellation,
): Promise<{ accepted: boolean; status: WorkflowExecution['status'] }> {
  const [{ execution }, { runContext }] = await Promise.all([
    deps.bus.request(WorkflowStorageSubjects.getExecution, { executionId }),
    deps.bus.request(WorkflowStorageSubjects.getRunContext, { executionId }),
  ]);
  if (!execution) throw new Error(`Authority execution not found: ${executionId}`);
  if (runContext?.executionId !== executionId || runContext.workflowId !== execution.workflowId) {
    throw new Error('authority cancellation run context identity mismatch');
  }
  if (runContext.terminalAuthority !== 'authority') {
    throw new Error('authority cancellation requires terminalAuthority=authority');
  }
  if (execution.status === 'cancelled') return { accepted: true, status: 'cancelled' };
  if (execution.status !== 'running') {
    throw new Error(`Authority cancellation conflicts with execution status: ${execution.status}`);
  }
  await cancelExecution(deps, executionId, cancellation.reason);
  const settled = await deps.bus.request(WorkflowStorageSubjects.getExecution, { executionId });
  if (settled.execution?.status !== 'cancelled') {
    throw new Error('Authority cancellation did not settle as cancelled');
  }
  return { accepted: true, status: 'cancelled' };
}
