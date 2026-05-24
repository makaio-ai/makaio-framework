import type { IMakaioBus } from '@makaio/bus-core';
import type { ExecutionStatus, StepState, WorkflowExecution } from '@makaio/contracts';
import { WorkflowStorageSubjects } from './storage/namespace.js';

/** Execution-level fields that can change after the initial execution insert. */
export interface ExecutionMetadataPatch {
  /** Current execution status. */
  status?: ExecutionStatus;
  /** Currently executing step ID, or `null` to clear it. */
  currentStepId?: string | null;
  /** Terminal execution error, or `null` to clear it. */
  error?: string | null;
  /** Terminal completion timestamp, or `null` to clear it. */
  completedAt?: number | null;
}

/**
 * Persist a metadata and/or step-state patch for one workflow execution.
 * @param bus - Message bus used for storage writes.
 * @param execution - Mutable in-memory execution state.
 * @param patch - Metadata fields and step IDs to persist.
 */
export async function persistExecutionUpdate(
  bus: IMakaioBus,
  execution: WorkflowExecution,
  patch: ExecutionMetadataPatch & { stepIds?: string[] },
): Promise<void> {
  const stepUpdates: Record<string, StepState> = {};
  for (const stepId of patch.stepIds ?? []) {
    const stepState = execution.steps[stepId];
    if (stepState === undefined) {
      throw new Error(`Cannot persist missing workflow step state: ${stepId}`);
    }
    stepUpdates[stepId] = stepState;
  }

  const result = await bus.request(WorkflowStorageSubjects.updateExecution, {
    executionId: execution.id,
    status: patch.status,
    currentStepId: patch.currentStepId,
    error: patch.error,
    completedAt: patch.completedAt,
    stepUpdates: Object.keys(stepUpdates).length > 0 ? stepUpdates : undefined,
  });

  if (!result.success) {
    throw new Error(`Workflow execution not found: ${execution.id}`);
  }
}

/**
 * Persist the current state of one workflow step.
 * @param bus - Message bus used for storage writes.
 * @param execution - Mutable in-memory execution state.
 * @param stepId - Step ID to persist.
 */
export async function persistStepState(bus: IMakaioBus, execution: WorkflowExecution, stepId: string): Promise<void> {
  await persistExecutionUpdate(bus, execution, { stepIds: [stepId] });
}

/**
 * Persist the current state of multiple workflow steps atomically.
 * @param bus - Message bus used for storage writes.
 * @param execution - Mutable in-memory execution state.
 * @param stepIds - Step IDs to persist.
 * @param metadata - Optional execution metadata patch to persist with the steps.
 */
export async function persistStepStates(
  bus: IMakaioBus,
  execution: WorkflowExecution,
  stepIds: string[],
  metadata: ExecutionMetadataPatch = {},
): Promise<void> {
  await persistExecutionUpdate(bus, execution, { ...metadata, stepIds });
}
