import type { IMakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from './namespace.js';
import { createStepCancelSubject, type IStepRunner, type WorkflowExecution } from '@makaio/contracts';
import type { ActiveExecution, ActiveRunnerStep } from './types.js';
import { persistExecutionUpdate } from './workflow-execution-persistence.js';

/**
 * Stable dependencies shared by all finalizer functions.
 *
 * Bundles the invariant params that every finalizer function needs,
 * avoiding parameter sprawl at each call site.
 */
export interface FinalizerDeps {
  /** Bus instance used for storage and event operations. */
  bus: IMakaioBus;
  /** Active execution map used to deregister finalized executions. */
  activeExecutions: Map<string, ActiveExecution>;
  /** Shell step abort controllers keyed by `{executionId}:{stepId}`. */
  shellAbortControllers: Map<string, AbortController>;
  /** Active runner step entries keyed by `{executionId}:{stepId}` for cancellation tracking. */
  activeRunnerSteps: Map<string, ActiveRunnerStep>;
  /** Step runner instance (used for forceKill on hard cancel). */
  stepRunner?: IStepRunner;
  /** Grace period in ms before forceKill is issued after cooperative abort. */
  cancelTimeoutMs?: number;
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
 * @param beforeExecutionFailed - Optional best-effort hook that runs after
 * durable failure state is persisted but before the execution-level failure event is emitted.
 */
export async function completeExecutionWithFailure(
  deps: FinalizerDeps,
  execution: WorkflowExecution,
  executionId: string,
  error: string,
  beforeExecutionFailed?: () => Promise<void>,
): Promise<void> {
  execution.status = 'failed';
  execution.error = error;
  execution.completedAt = Date.now();
  try {
    await persistExecutionUpdate(deps.bus, execution, {
      status: execution.status,
      error: execution.error,
      completedAt: execution.completedAt,
    });
    try {
      await beforeExecutionFailed?.();
    } catch (hookError) {
      console.error('[WorkflowFinalizer] Failed to run failure pre-emit hook:', hookError);
    }
    await deps.bus.emit(WorkflowSubjects.execution.failed, { executionId, error });
  } finally {
    deps.activeExecutions.delete(executionId);
  }
}

/**
 * Cancel all active runner steps for a given execution.
 *
 * Aborts each tracked step's AbortController, which triggers the cooperative
 * cancellation signal. It also emits the per-step cancellation bus subject so
 * remote workers can observe cancellation through their own bus connection.
 * @param deps - Finalizer dependencies (requires activeRunnerSteps).
 * @param executionId - Execution identifier whose runner steps should be cancelled.
 * @param reason - Optional cancellation reason to forward to remote workers.
 */
export function cancelActiveRunnerSteps(deps: FinalizerDeps, executionId: string, reason?: string): void {
  const { activeRunnerSteps, bus } = deps;

  const prefix = `${executionId}:`;
  for (const [key, entry] of activeRunnerSteps) {
    if (!key.startsWith(prefix)) continue;
    const stepId = key.slice(prefix.length);
    entry.controller.abort();
    void bus
      .emit(createStepCancelSubject(entry.cancelSubject), { executionId, stepId, reason })
      .catch((error: unknown) => {
        console.error(`[WorkflowFinalizer] Failed to emit cancellation for ${key}:`, error);
      });
  }
}

/**
 * Cancel a running workflow execution and release all active step resources.
 *
 * In the primitive runtime, the abort signal drives frame-level cancellation.
 * This function handles the execution-level state transition:
 * - Updates execution status to `cancelled`
 * - Aborts shell controllers for any in-flight shell steps
 * - Cancels active runner steps (cooperative abort + hard kill timer)
 * - Persists the cancelled status
 * - Emits `execution.cancelled`
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
    for (const [key, controller] of deps.shellAbortControllers) {
      if (key.startsWith(`${executionId}:`)) {
        controller.abort();
        deps.shellAbortControllers.delete(key);
      }
    }

    // Cancel active runner steps (cooperative abort).
    cancelActiveRunnerSteps(deps, executionId, reason);

    await persistExecutionUpdate(deps.bus, execution, {
      status: execution.status,
      completedAt: execution.completedAt,
    });

    await deps.bus.emit(WorkflowSubjects.execution.cancelled, { executionId, reason });
  } finally {
    deps.activeExecutions.delete(executionId);
  }

  return true;
}
