import type { IMakaioBus } from '@makaio/bus-core';
import type { WorkflowExecution, WorkflowGateInstance, WorkflowRunContext } from '@makaio/contracts';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import type { ActiveExecution } from './types.js';
import type { WorkflowGateTimeoutPayload } from './workflow-gate-timeout-scheduler.js';
import { withExecutionDurableTransition, type FinalizerDeps } from './workflow-execution-finalizer.js';

type PausedWorkflowExecution = WorkflowExecution & { readonly status: 'paused' };
type WaitingWorkflowGateInstance = WorkflowGateInstance & { readonly status: 'waiting' };

/**
 * Check whether an execution is paused and can be resumed from storage.
 * @param execution - Execution row returned from storage.
 * @returns True when the execution is paused.
 */
export function isPausedWorkflowExecution(
  execution: WorkflowExecution | null | undefined,
): execution is PausedWorkflowExecution {
  return execution?.status === 'paused';
}

/**
 * Check whether a persisted gate instance is still waiting.
 * @param gate - Gate instance returned from storage.
 * @returns True when the gate can still accept a response.
 */
function isWaitingGateInstance(gate: WorkflowGateInstance | null): gate is WaitingWorkflowGateInstance {
  return gate?.status === 'waiting';
}

/**
 * Restore paused state after a manual gate response wins persistence but the
 * resume dispatch fails before a runner task can own the execution.
 *
 * The gate response path first atomically transitions the gate out of
 * `waiting`; if the subsequent paused-\>running dispatch cannot launch, the
 * original paused execution and waiting gate must be restored together so
 * another response or timeout can retry the same gate.
 * Restoration shares the owner's lifecycle queue with cancellation and refuses
 * terminal owners; a delayed preparation failure must not resurrect stale state.
 * @param deps - Storage bus and the current owner's lifecycle transition queue.
 * @param activeExecutions - Active execution ownership map maintained by the executor.
 * @param executionTasks - In-flight execution task map maintained by the executor.
 * @param workflowAbortControllers - Abort controllers registered for workflow-level runner tasks.
 * @param execution - Paused execution snapshot observed before the response.
 * @param gate - Waiting gate snapshot observed before the response.
 * @param gateId - Gate node ID used in rollback diagnostics.
 */
export async function restorePausedGateAfterResumeFailure(
  deps: Pick<FinalizerDeps, 'bus' | 'durableLifecycleTransitions'>,
  activeExecutions: Map<string, ActiveExecution>,
  executionTasks: Map<string, Promise<void>>,
  workflowAbortControllers: Map<string, AbortController>,
  execution: PausedWorkflowExecution,
  gate: WaitingWorkflowGateInstance,
  gateId: string,
): Promise<void> {
  try {
    await withExecutionDurableTransition(deps, execution.id, async () => {
      const current = await deps.bus.request(WorkflowStorageSubjects.getExecution, { executionId: execution.id });
      if (current.execution?.status !== 'paused' && current.execution?.status !== 'running') return;
      activeExecutions.delete(execution.id);
      executionTasks.delete(execution.id);
      workflowAbortControllers.delete(execution.id);
      await deps.bus.request(WorkflowStorageSubjects.restorePausedGateResumeState, { execution, gate });
    });
  } catch (rollbackError: unknown) {
    console.error(
      `[WorkflowExecutor] Failed to restore paused gate '${gateId}' after resume launch failure:`,
      rollbackError,
    );
  }
}

/**
 * Ensure exit-based resumes have durable frame state before dispatch.
 * @param bus - Workflow storage bus used to inspect persisted frames.
 * @param runContext - Persisted context for the paused execution.
 */
export async function assertDurableResumeFramesPresent(
  bus: IMakaioBus,
  runContext: Pick<WorkflowRunContext, 'executionId' | 'suspensionStrategy'>,
): Promise<void> {
  if (runContext.suspensionStrategy === 'wait-in-process') return;

  const { frames } = await bus.request(WorkflowStorageSubjects.listFrames, {
    executionId: runContext.executionId,
  });
  if (frames.length === 0) {
    throw new Error(`[WorkflowExecutor] Missing resume frames for paused execution: ${runContext.executionId}`);
  }
}

/**
 * Convert a persisted gate instance into the scheduler payload contract.
 * @param gate - Waiting finite-timeout gate instance.
 * @returns Scheduler payload for the gate timeout wakeup.
 */
export function toGateTimeoutPayload(gate: WorkflowGateInstance): WorkflowGateTimeoutPayload {
  return {
    executionId: gate.executionId,
    nodeId: gate.nodeId,
    frameId: gate.frameId,
    timeoutMs: gate.timeoutMs,
    openedAt: gate.createdAt,
  };
}

/**
 * Load the waiting gate targeted by a paused `gate.respond` request.
 *
 * Responses with a frame ID must match that concrete frame. Responses without
 * one are accepted only when the execution has exactly one waiting instance
 * for the requested gate node, preserving the public contract while rejecting
 * iterate-expanded ambiguity.
 * @param bus - Workflow storage bus used to inspect gate instances.
 * @param target - Gate identity from the response payload.
 * @returns The unique waiting gate instance, or `null` when absent or ambiguous.
 */
export async function loadUniqueWaitingGateInstance(
  bus: IMakaioBus,
  target: { readonly executionId: string; readonly nodeId: string; readonly frameId?: string },
): Promise<WaitingWorkflowGateInstance | null> {
  if (target.frameId !== undefined) {
    const { gate } = await bus.request(WorkflowStorageSubjects.getGateInstance, target);
    return isWaitingGateInstance(gate) ? gate : null;
  }

  const { gates } = await bus.request(WorkflowStorageSubjects.listGateInstances, {
    executionId: target.executionId,
  });
  const matchingWaitingGates = gates.filter(
    (gate): gate is WaitingWorkflowGateInstance => gate.nodeId === target.nodeId && gate.status === 'waiting',
  );
  return matchingWaitingGates.length === 1 ? matchingWaitingGates[0] : null;
}
