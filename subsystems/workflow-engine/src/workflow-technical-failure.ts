import type { CallContext } from '@makaio/core';
import type { WorkflowExecution } from '@makaio/contracts';
import { completeExecutionWithFailure, type FinalizerDeps } from './workflow-execution-finalizer.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';

/**
 * Converge a reported technical failure through the workflow finalizer.
 * No executable definition is needed: startup may fail before it can be loaded.
 * @param call - Call context of the work that commits the technical failure.
 * @param deps - The executor's existing durable lifecycle and publication dependencies.
 * @param executionId - Durable authority-owned workflow execution identity.
 * @param error - Final error text reported by the authority.
 * @returns The durable status after idempotent owner convergence.
 */
export async function acceptWorkflowTechnicalFailure(
  call: CallContext,
  deps: FinalizerDeps,
  executionId: string,
  error: string,
): Promise<{ accepted: boolean; status: WorkflowExecution['status'] }> {
  const [{ execution }, { runContext }] = await Promise.all([
    deps.bus.request(call, WorkflowStorageSubjects.getExecution, { executionId }),
    deps.bus.request(call, WorkflowStorageSubjects.getRunContext, { executionId }),
  ]);
  if (!execution) throw new Error(`Authority execution not found: ${executionId}`);
  if (runContext?.executionId !== executionId || runContext.workflowId !== execution.workflowId) {
    throw new Error('authority technical failure run context identity mismatch');
  }
  if (runContext.terminalAuthority !== 'authority') {
    throw new Error('authority technical failure requires terminalAuthority=authority');
  }
  // A failed stop remains a technical diagnostic, but cannot undo an
  // owner's durable cancellation. Replay accepts either settled owner state.
  if (execution.status === 'failed' || execution.status === 'cancelled') {
    return { accepted: true, status: execution.status };
  }
  if (execution.status !== 'running') {
    throw new Error(`Authority technical failure conflicts with execution status: ${execution.status}`);
  }
  await completeExecutionWithFailure(call, deps, execution, executionId, error);
  const settled = await deps.bus.request(call, WorkflowStorageSubjects.getExecution, { executionId });
  // Cancellation may win the serialized transition after the initial read.
  if (settled.execution?.status !== 'failed' && settled.execution?.status !== 'cancelled') {
    throw new Error('Authority technical failure did not settle as failed or cancelled');
  }
  return { accepted: true, status: settled.execution.status };
}
