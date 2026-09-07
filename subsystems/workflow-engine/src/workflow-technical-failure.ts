import type { WorkflowExecution } from '@makaio/contracts';
import type { WorkflowAttemptTechnicalFailure } from './workflow-attempt-outcome.js';
import { completeExecutionWithFailure, type FinalizerDeps } from './workflow-execution-finalizer.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';

/**
 * Converge a committed technical Attempt failure through the workflow finalizer.
 * No executable definition is needed: startup may fail before it can be loaded.
 * @param deps - The executor's existing durable lifecycle and publication dependencies.
 * @param executionId - Durable authority-owned workflow execution identity.
 * @param failure - Canonical technical failure retained in Attempt storage.
 * @returns The durable status after idempotent owner convergence.
 */
export async function acceptWorkflowTechnicalFailure(
  deps: FinalizerDeps,
  executionId: string,
  failure: WorkflowAttemptTechnicalFailure,
): Promise<{ accepted: boolean; status: WorkflowExecution['status'] }> {
  const [{ execution }, { runContext }] = await Promise.all([
    deps.bus.request(WorkflowStorageSubjects.getExecution, { executionId }),
    deps.bus.request(WorkflowStorageSubjects.getRunContext, { executionId }),
  ]);
  if (!execution) throw new Error(`Authority execution not found: ${executionId}`);
  if (runContext?.executionId !== executionId || runContext.workflowId !== execution.workflowId) {
    throw new Error('authority technical failure run context identity mismatch');
  }
  if (runContext.terminalAuthority !== 'authority') {
    throw new Error('authority technical failure requires terminalAuthority=authority');
  }
  // A failed stop remains a technical Attempt diagnostic, but cannot undo an
  // owner's durable cancellation. Replay accepts either settled owner state.
  if (execution.status === 'failed' || execution.status === 'cancelled') {
    return { accepted: true, status: execution.status };
  }
  if (execution.status !== 'running') {
    throw new Error(`Authority technical failure conflicts with execution status: ${execution.status}`);
  }
  await completeExecutionWithFailure(deps, execution, executionId, `${failure.stage}: ${failure.message}`);
  const settled = await deps.bus.request(WorkflowStorageSubjects.getExecution, { executionId });
  // Cancellation may win the serialized transition after the initial read.
  if (settled.execution?.status !== 'failed' && settled.execution?.status !== 'cancelled') {
    throw new Error('Authority technical failure did not settle as failed or cancelled');
  }
  return { accepted: true, status: settled.execution.status };
}
