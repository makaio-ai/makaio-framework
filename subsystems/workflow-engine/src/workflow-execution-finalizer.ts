import type { IMakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from './namespace.js';
import { SubagentSubjects, type WorkflowExecution, type StepState } from '@makaio/contracts';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import type { ActiveExecution } from './types.js';
import type { WorkflowGateCoordinator } from './workflow-gate-coordinator.js';

/**
 * Finalize an execution as completed.
 * @param bus - Bus instance used for storage writes and event emission.
 * @param activeExecutions - Active execution map to remove finalized execution from.
 * @param execution - Mutable execution state.
 * @param executionId - Execution identifier.
 * @param startTime - Epoch ms when execution started.
 */
export async function completeExecutionWithSuccess(
  bus: IMakaioBus,
  activeExecutions: Map<string, ActiveExecution>,
  execution: WorkflowExecution,
  executionId: string,
  startTime: number,
): Promise<void> {
  execution.status = 'completed';
  execution.completedAt = Date.now();
  await bus.request(WorkflowStorageSubjects.setExecution, { execution });
  await bus.emit(WorkflowSubjects.completed, { executionId, totalDuration: Date.now() - startTime });
  activeExecutions.delete(executionId);
}

/**
 * Finalize an execution as failed.
 * @param bus - Bus instance used for storage writes and event emission.
 * @param activeExecutions - Active execution map to remove finalized execution from.
 * @param execution - Mutable execution state.
 * @param executionId - Execution identifier.
 * @param error - Human-readable failure reason.
 * @param failedStepId - Optional failed step identifier.
 */
export async function completeExecutionWithFailure(
  bus: IMakaioBus,
  activeExecutions: Map<string, ActiveExecution>,
  execution: WorkflowExecution,
  executionId: string,
  error: string,
  failedStepId?: string,
): Promise<void> {
  execution.status = 'failed';
  execution.error = error;
  execution.completedAt = Date.now();
  await bus.request(WorkflowStorageSubjects.setExecution, { execution });
  await bus.emit(WorkflowSubjects.failed, { executionId, error, failedStepId });
  activeExecutions.delete(executionId);
}

/**
 * Mark one step as failed and persist updated execution state.
 * @param bus - Bus instance used for storage writes and event emission.
 * @param execution - Mutable execution state.
 * @param executionId - Execution identifier.
 * @param stepId - Failed step identifier.
 * @param stepState - Mutable step state.
 * @param error - Human-readable step failure reason.
 */
export async function markStepFailed(
  bus: IMakaioBus,
  execution: WorkflowExecution,
  executionId: string,
  stepId: string,
  stepState: StepState,
  error: string,
): Promise<void> {
  stepState.status = 'failed';
  stepState.error = error;
  stepState.completedAt = Date.now();
  await bus.request(WorkflowStorageSubjects.setExecution, { execution });
  await bus.emit(WorkflowSubjects.stepFailed, { executionId, stepId, error });
}

/**
 * Cancel a running workflow execution and release all active step resources.
 * @param bus - Bus instance used for subagent, storage, and event operations.
 * @param activeExecutions - Active execution map to remove the cancelled execution from.
 * @param shellAbortControllers - Shell step abort controllers keyed by execution and step.
 * @param gateCoordinator - Gate coordinator used to release waiting gate steps.
 * @param executionId - Execution identifier to cancel.
 * @returns True when an active running execution was cancelled.
 */
export async function cancelExecution(
  bus: IMakaioBus,
  activeExecutions: Map<string, ActiveExecution>,
  shellAbortControllers: Map<string, AbortController>,
  gateCoordinator: WorkflowGateCoordinator,
  executionId: string,
): Promise<boolean> {
  const active = activeExecutions.get(executionId);

  if (!active || active.execution.status !== 'running') {
    return false;
  }

  const { execution } = active;
  execution.status = 'cancelled';
  execution.completedAt = Date.now();

  const activeStepEntries = Object.entries(execution.steps).filter(
    ([, state]) => state.status === 'running' || state.status === 'waiting',
  );

  await Promise.all(
    activeStepEntries
      .filter((entry): entry is [string, StepState & { subagentId: string }] => typeof entry[1].subagentId === 'string')
      .map(([, state]) =>
        bus
          .request(SubagentSubjects.kill, {
            subagentId: state.subagentId,
            reason: 'Workflow cancelled',
          })
          .catch(() => {}),
      ),
  );

  const cancelledStepIds: string[] = [];
  for (const [stepId, stepState] of activeStepEntries) {
    gateCoordinator.resolveForCancellation(executionId, stepId);

    execution.steps[stepId] = {
      ...stepState,
      status: 'failed',
      error: 'Workflow cancelled',
      completedAt: Date.now(),
    };
    cancelledStepIds.push(stepId);
  }

  for (const [key, controller] of shellAbortControllers) {
    if (key.startsWith(`${executionId}:`)) {
      controller.abort();
      shellAbortControllers.delete(key);
    }
  }

  await bus.request(WorkflowStorageSubjects.setExecution, { execution });
  for (const stepId of cancelledStepIds) {
    await bus.emit(WorkflowSubjects.stepFailed, { executionId, stepId, error: 'Workflow cancelled' });
  }
  await bus.emit(WorkflowSubjects.cancelled, { executionId });

  activeExecutions.delete(executionId);

  return true;
}
