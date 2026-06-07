import type { IMakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
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
      workflowId: execution.workflowId,
      totalDuration: execution.completedAt - startTime,
      completedAt: execution.completedAt,
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
    await deps.bus.emit(WorkflowSubjects.execution.failed, {
      executionId,
      workflowId: execution.workflowId,
      error,
      completedAt: execution.completedAt,
    });
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
 * Cancel an execution that is parked in storage without active runtime ownership.
 *
 * Exit-and-redispatch providers release the executor's active execution entry
 * after the gate is durably parked. A later public cancel must still
 * terminalize the paused execution and its waiting gates so timeout/manual
 * resume paths cannot continue the run.
 * @param deps - Finalizer dependencies.
 * @param executionId - Paused execution identifier to cancel.
 * @param reason - Optional human-readable cancellation reason.
 * @returns True when a paused execution was cancelled.
 */
async function cancelPausedExecution(deps: FinalizerDeps, executionId: string, reason?: string): Promise<boolean> {
  const existing = await deps.bus.request(WorkflowStorageSubjects.getExecution, { executionId });
  if (existing.execution == null) return false;

  const workflowId = existing.execution.workflowId;
  if (workflowId === undefined) {
    throw new Error(`Paused execution ${executionId} is missing stored workflowId`);
  }

  const completedAt = Date.now();
  const { cancelled, gates } = await deps.bus.request(WorkflowStorageSubjects.cancelPausedExecution, {
    executionId,
    completedAt,
  });
  if (!cancelled) return false;

  for (const gate of gates) {
    await deps.bus
      .emit(WorkflowSubjects.gate.resolved, {
        executionId,
        stepId: gate.nodeId,
        stepType: 'gate',
        frameId: gate.frameId,
        source: 'cancelled',
      })
      .catch((error: unknown) => {
        console.error(`[WorkflowFinalizer] Failed to emit cancelled gate resolution for ${gate.frameId}:`, error);
      });
  }

  await deps.bus.emit(WorkflowSubjects.execution.cancelled, {
    executionId,
    workflowId,
    reason,
    completedAt,
  });
  deps.activeExecutions.delete(executionId);
  return true;
}

/**
 * Cancel a running or parked workflow execution and release active resources.
 *
 * In the primitive runtime, the abort signal drives frame-level cancellation.
 * This function handles the execution-level state transition:
 * - Updates execution status to `cancelled`
 * - Aborts shell controllers for any in-flight shell steps
 * - Cancels active runner steps (cooperative abort + hard kill timer)
 * - Cancels waiting gate rows for parked paused executions
 * - Persists the cancelled status
 * - Emits `execution.cancelled`
 * @param deps - Finalizer dependencies.
 * @param executionId - Execution identifier to cancel.
 * @param reason - Optional human-readable cancellation reason.
 * @returns True when a running or parked execution was cancelled.
 */
export async function cancelExecution(deps: FinalizerDeps, executionId: string, reason?: string): Promise<boolean> {
  const active = deps.activeExecutions.get(executionId);

  if (!active || active.execution.status !== 'running') {
    return cancelPausedExecution(deps, executionId, reason);
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

    await deps.bus.emit(WorkflowSubjects.execution.cancelled, {
      executionId,
      workflowId: execution.workflowId,
      reason,
      completedAt: execution.completedAt,
    });
  } finally {
    deps.activeExecutions.delete(executionId);
  }

  return true;
}
