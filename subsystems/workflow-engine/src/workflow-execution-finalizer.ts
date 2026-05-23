import type { IMakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from './namespace.js';
import { SubagentSubjects, type WorkflowExecution, type StepState } from '@makaio/contracts';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import type { ActiveExecution } from './types.js';
import type { WorkflowGateCoordinator } from './workflow-gate-coordinator.js';

/** Parameters for marking a workflow step failed. */
export interface MarkStepFailedParams {
  /** Bus instance used for storage writes and event emission. */
  bus: IMakaioBus;
  /** Mutable execution state. */
  execution: WorkflowExecution;
  /** Execution identifier. */
  executionId: string;
  /** Failed step identifier. */
  stepId: string;
  /** Step type for lifecycle event payload. */
  stepType: 'agent' | 'shell' | 'gate';
  /** Mutable step state. */
  stepState: StepState;
  /** Human-readable step failure reason. */
  error: string;
}

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
  try {
    await bus.emit(WorkflowSubjects.execution.completed, { executionId, totalDuration: Date.now() - startTime });
  } finally {
    activeExecutions.delete(executionId);
  }
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
  try {
    await bus.emit(WorkflowSubjects.execution.failed, { executionId, error, failedStepId });
  } finally {
    activeExecutions.delete(executionId);
  }
}

/**
 * Mark one step as failed and persist updated execution state.
 * @param params - Failure update parameters.
 */
export async function markStepFailed(params: MarkStepFailedParams): Promise<void> {
  const { bus, execution, executionId, stepId, stepType, stepState, error } = params;
  stepState.status = 'failed';
  stepState.error = error;
  stepState.completedAt = Date.now();
  await bus.request(WorkflowStorageSubjects.setExecution, { execution });
  await bus.emit(WorkflowSubjects.step.failed, { executionId, stepId, stepType, error });
}

/**
 * Cancel a running workflow execution and release all active step resources.
 * @param bus - Bus instance used for subagent, storage, and event operations.
 * @param activeExecutions - Active execution map to remove the cancelled execution from.
 * @param shellAbortControllers - Shell step abort controllers keyed by execution and step.
 * @param gateCoordinator - Gate coordinator used to release waiting gate steps.
 * @param executionId - Execution identifier to cancel.
 * @param reason - Optional human-readable cancellation reason.
 * @returns True when an active running execution was cancelled.
 */
export async function cancelExecution(
  bus: IMakaioBus,
  activeExecutions: Map<string, ActiveExecution>,
  shellAbortControllers: Map<string, AbortController>,
  gateCoordinator: WorkflowGateCoordinator,
  executionId: string,
  reason?: string,
): Promise<boolean> {
  const active = activeExecutions.get(executionId);

  if (!active || active.execution.status !== 'running') {
    return false;
  }

  const { execution } = active;
  execution.status = 'cancelled';
  execution.completedAt = Date.now();

  try {
    const activeStepEntries = Object.entries(execution.steps).filter(
      ([, state]) => state.status === 'running' || state.status === 'waiting',
    );

    await Promise.all(
      activeStepEntries
        .filter(
          (entry): entry is [string, StepState & { subagentId: string }] => typeof entry[1].subagentId === 'string',
        )
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
    await Promise.all(
      cancelledStepIds.map((stepId) => {
        const stepType = active.stepMap.get(stepId)?.type ?? 'agent';
        const resolvedStepType = stepType === 'for-each' ? 'agent' : stepType;
        return bus.emit(WorkflowSubjects.step.failed, {
          executionId,
          stepId,
          stepType: resolvedStepType as 'agent' | 'shell' | 'gate',
          error: 'Workflow cancelled',
        });
      }),
    );
    await bus.emit(WorkflowSubjects.execution.cancelled, { executionId, reason });
  } finally {
    activeExecutions.delete(executionId);
  }

  return true;
}
