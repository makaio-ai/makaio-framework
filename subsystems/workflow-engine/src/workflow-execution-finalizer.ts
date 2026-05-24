import type { IMakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from './namespace.js';
import {
  SubagentSubjects,
  type CompositeStepState,
  type ExecutableStepState,
  type IStepRunner,
  type WorkflowExecution,
  type WorkflowStepType,
} from '@makaio/contracts';
import type { ActiveExecution, ActiveRunnerStep } from './types.js';
import type { WorkflowGateCoordinator } from './workflow-gate-coordinator.js';
import { persistExecutionUpdate, persistStepState, persistStepStates } from './workflow-execution-persistence.js';

/**
 * Stable dependencies shared by all finalizer functions.
 *
 * Bundles the invariant params that every finalizer function needs,
 * avoiding parameter sprawl at each call site.
 */
export interface FinalizerDeps {
  /** Bus instance used for subagent, storage, and event operations. */
  bus: IMakaioBus;
  /** Active execution map used to deregister finalized executions. */
  activeExecutions: Map<string, ActiveExecution>;
  /** Shell step abort controllers keyed by `{executionId}:{stepId}`. */
  shellAbortControllers: Map<string, AbortController>;
  /** Active runner step entries keyed by `{executionId}:{stepId}` for cancellation tracking. */
  activeRunnerSteps?: Map<string, ActiveRunnerStep>;
  /** Step runner instance (used for forceKill on hard cancel). */
  stepRunner?: IStepRunner;
  /** Grace period in ms before forceKill is issued after cooperative abort. */
  cancelTimeoutMs?: number;
  /** Gate coordinator used to release waiting gate steps. */
  gateCoordinator: WorkflowGateCoordinator;
}

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
  stepType: WorkflowStepType;
  /** Mutable executable step state. */
  stepState: ExecutableStepState;
  /** Human-readable step failure reason. */
  error: string;
}

/** IDs changed while terminalizing an execution. */
export interface TerminalizedStepIds {
  /** All step IDs whose state was terminalized. */
  stepIds: string[];
  /** Executable step IDs that need failed lifecycle events. */
  executableIds: string[];
}

/**
 * Finalize an execution as completed.
 * @param deps - Finalizer dependencies.
 * @param execution - Mutable execution state.
 * @param executionId - Execution identifier.
 * @param startTime - Epoch ms when execution started.
 */
export async function completeExecutionWithSuccess(
  deps: FinalizerDeps,
  execution: WorkflowExecution,
  executionId: string,
  startTime: number,
): Promise<void> {
  execution.status = 'completed';
  execution.completedAt = Date.now();
  try {
    await persistExecutionUpdate(deps.bus, execution, {
      status: execution.status,
      completedAt: execution.completedAt,
    });
    await deps.bus.emit(WorkflowSubjects.execution.completed, {
      executionId,
      totalDuration: Date.now() - startTime,
    });
  } finally {
    deps.activeExecutions.delete(executionId);
  }
}

/**
 * Finalize an execution as failed.
 * @param deps - Finalizer dependencies.
 * @param execution - Mutable execution state.
 * @param executionId - Execution identifier.
 * @param error - Human-readable failure reason.
 * @param failedStepId - Optional failed step identifier.
 * @param changedStepIds - Step IDs terminalized with the failure metadata.
 * @param beforeExecutionFailed - Optional best-effort hook that runs after
 * durable failure state is persisted but before the execution-level failure event is emitted.
 */
export async function completeExecutionWithFailure(
  deps: FinalizerDeps,
  execution: WorkflowExecution,
  executionId: string,
  error: string,
  failedStepId?: string,
  changedStepIds: string[] = [],
  beforeExecutionFailed?: () => Promise<void>,
): Promise<void> {
  execution.status = 'failed';
  execution.error = error;
  execution.completedAt = Date.now();
  try {
    await persistStepStates(deps.bus, execution, changedStepIds, {
      status: execution.status,
      error: execution.error,
      completedAt: execution.completedAt,
    });
    try {
      await beforeExecutionFailed?.();
    } catch (hookError) {
      console.error('[WorkflowFinalizer] Failed to run failure pre-emit hook:', hookError);
    }
    await deps.bus.emit(WorkflowSubjects.execution.failed, { executionId, error, failedStepId });
  } finally {
    deps.activeExecutions.delete(executionId);
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
  await persistStepState(bus, execution, stepId);
  await bus.emit(WorkflowSubjects.step.failed, { executionId, stepId, stepType, error });
}

/** Non-terminal step statuses that must be resolved before an execution is terminal. */
const NON_TERMINAL_STATUSES = new Set(['pending', 'running', 'waiting', 'expanding']);

/**
 * Terminalize all steps that are not yet in a terminal state.
 *
 * - Composite steps (for-each): set to `'cancelled'`
 * - Executable steps: set to `'failed'` with the provided error message
 *
 * Returns IDs that were transitioned, split between all persisted steps and
 * executable steps that need lifecycle event emission.
 * Composite steps are internal scheduling details and do not emit lifecycle events.
 * @param execution - Mutable execution state to update in place.
 * @param error - Failure message applied to executable steps.
 * @param active - Active execution registry entry for gate resolution.
 * @param gateCoordinator - Gate coordinator to unblock waiting gate steps.
 * @returns Terminalized step ID groups.
 */
export function terminalizeNonTerminalSteps(
  execution: WorkflowExecution,
  error: string,
  active: ActiveExecution,
  gateCoordinator: WorkflowGateCoordinator,
): TerminalizedStepIds {
  const stepIds: string[] = [];
  const executableIds: string[] = [];
  const now = Date.now();

  for (const [stepId, stepState] of Object.entries(execution.steps)) {
    if (!NON_TERMINAL_STATUSES.has(stepState.status)) continue;
    stepIds.push(stepId);

    if (stepState.status === 'waiting') {
      gateCoordinator.resolveForCancellation(active.execution.id, stepId);
    }

    if (stepState.kind === 'composite') {
      const cancelled: CompositeStepState = {
        ...stepState,
        status: 'cancelled',
        completedAt: now,
      };
      execution.steps[stepId] = cancelled;
    } else {
      const failed: ExecutableStepState = {
        ...stepState,
        status: 'failed',
        error,
        completedAt: now,
      };
      execution.steps[stepId] = failed;
      executableIds.push(stepId);
    }
  }

  return { stepIds, executableIds };
}

/**
 * Emit `step.failed` lifecycle events for all terminated executable step IDs.
 *
 * Composite steps are internal scheduling constructs — no lifecycle event is emitted.
 * Call this after {@link terminalizeNonTerminalSteps} to notify observers of each failed step.
 * @param deps - Finalizer dependencies.
 * @param executionId - Execution identifier.
 * @param terminatedIds - Executable step IDs that were transitioned to failed.
 */
export async function emitTerminatedStepEvents(
  deps: FinalizerDeps,
  executionId: string,
  terminatedIds: string[],
): Promise<void> {
  if (terminatedIds.length === 0) return;

  const active = deps.activeExecutions.get(executionId);
  if (!active) return;

  await Promise.all(
    terminatedIds.map((stepId) => {
      const stepType = active.stepMap.get(stepId)?.type ?? 'agent';
      const resolvedStepType: WorkflowStepType = stepType === 'for-each' ? 'agent' : (stepType as WorkflowStepType);
      const stepState = active.execution.steps[stepId];
      const error = stepState?.kind === 'executable' ? (stepState.error ?? 'Workflow failed') : 'Workflow failed';
      return deps.bus.emit(WorkflowSubjects.step.failed, {
        executionId,
        stepId,
        stepType: resolvedStepType,
        error,
      });
    }),
  );
}

/**
 * Cancel all active runner steps for a given execution.
 *
 * Aborts each tracked step's AbortController, which triggers the cooperative
 * cancellation signal. The hard kill timer is scheduled by the abort event
 * listener registered in the scheduler's `runExecutableNode` — this function
 * only needs to fire the signal.
 * @param deps - Finalizer dependencies (requires activeRunnerSteps).
 * @param executionId - Execution identifier whose runner steps should be cancelled.
 */
export function cancelActiveRunnerSteps(deps: FinalizerDeps, executionId: string): void {
  const { activeRunnerSteps } = deps;
  if (!activeRunnerSteps) return;

  const prefix = `${executionId}:`;
  for (const [key, entry] of activeRunnerSteps) {
    if (!key.startsWith(prefix)) continue;
    entry.controller.abort();
  }
}

/**
 * Cancel a running workflow execution and release all active step resources.
 *
 * Terminates all steps that are not already in a terminal state:
 * - `pending`, `running`, `waiting`, and `expanding` steps are transitioned
 * - Composite steps become `cancelled`; executable steps become `failed`
 * - Subagents for running/waiting executable steps are killed
 * - Shell abort controllers are fired
 * - Active runner steps are aborted with a hard kill timer
 * - Gate steps are resolved for cancellation
 * @param deps - Finalizer dependencies.
 * @param executionId - Execution identifier to cancel.
 * @param reason - Optional human-readable cancellation reason.
 * @returns True when an active running execution was cancelled.
 */
export async function cancelExecution(deps: FinalizerDeps, executionId: string, reason?: string): Promise<boolean> {
  const active = deps.activeExecutions.get(executionId);

  if (!active || active.execution.status !== 'running') {
    return false;
  }

  const { execution } = active;
  execution.status = 'cancelled';
  execution.completedAt = Date.now();

  try {
    // Kill any subagents that are currently running or waiting before we
    // terminalize their step states, so the kill RPC sees valid subagentIds.
    const runningEntries = Object.entries(execution.steps).filter(
      ([, state]) => state.status === 'running' || state.status === 'waiting',
    );
    await Promise.all(
      runningEntries
        .filter(
          (entry): entry is [string, ExecutableStepState & { subagentId: string }] =>
            entry[1].kind === 'executable' && typeof entry[1].subagentId === 'string',
        )
        .map(([, state]) =>
          deps.bus
            .request(SubagentSubjects.kill, {
              subagentId: state.subagentId,
              reason: 'Workflow cancelled',
            })
            .catch(() => {}),
        ),
    );

    // Terminalize ALL non-terminal steps (pending, running, waiting, expanding).
    const terminatedIds = terminalizeNonTerminalSteps(execution, 'Workflow cancelled', active, deps.gateCoordinator);

    for (const [key, controller] of deps.shellAbortControllers) {
      if (key.startsWith(`${executionId}:`)) {
        controller.abort();
        deps.shellAbortControllers.delete(key);
      }
    }

    // Cancel active runner steps (cooperative abort + hard kill timer).
    cancelActiveRunnerSteps(deps, executionId);

    // Persist once after all step and metadata mutations.
    await persistStepStates(deps.bus, execution, terminatedIds.stepIds, {
      status: execution.status,
      completedAt: execution.completedAt,
    });

    await emitTerminatedStepEvents(deps, executionId, terminatedIds.executableIds);
    await deps.bus.emit(WorkflowSubjects.execution.cancelled, { executionId, reason });
  } finally {
    deps.activeExecutions.delete(executionId);
  }

  return true;
}
