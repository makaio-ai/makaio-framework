import type { WorkflowRunResult } from '@makaio/contracts';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import { commitExecutionLifecycleTransition, type FinalizerDeps } from './workflow-execution-finalizer.js';

/**
 * Park a runner result using the owner's shared Cancel/Resume ordering point.
 * An already parked execution releases local ownership without republishing.
 * @param deps - Owner lifecycle dependencies.
 * @param result - Correlated paused result carrying its gate identity.
 * @returns Whether the serialized transition accepted this pause, including replay.
 */
export async function parkExecution(deps: FinalizerDeps, result: WorkflowRunResult): Promise<boolean> {
  if (result.pausedAtGateId === undefined || result.pausedAtFrameId === undefined) {
    throw new Error(`Paused runner result for '${result.executionId}' is missing gate identity`);
  }
  const decision = await commitExecutionLifecycleTransition(
    deps,
    result.executionId,
    async () => {
      const { paused: transitioned } = await deps.bus.request(WorkflowStorageSubjects.pauseRunningExecution, {
        executionId: result.executionId,
      });
      if (!transitioned) {
        const { execution } = await deps.bus.request(WorkflowStorageSubjects.getExecution, {
          executionId: result.executionId,
        });
        if (execution?.status !== 'paused') return 'refused';
      }
      const active = deps.activeExecutions.get(result.executionId);
      if (active !== undefined) active.execution.status = 'paused';
      deps.activeExecutions.delete(result.executionId);
      return transitioned ? 'transitioned' : 'replayed';
    },
    async (committed) => {
      if (committed !== 'transitioned') return;
      await deps.bus.emit(WorkflowSubjects.execution.paused, {
        executionId: result.executionId,
        workflowId: result.workflowId,
        pausedAtGateId: result.pausedAtGateId,
        pausedAtFrameId: result.pausedAtFrameId,
      });
    },
  );
  // A subscriber may already have resumed the owner while publication awaited.
  // Acceptance belongs to the serialized transition, not a later mutable read.
  return decision !== 'refused';
}
