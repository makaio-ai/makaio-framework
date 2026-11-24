import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/core';
import {
  requireExecutableRunContext,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowRunResult,
} from '@makaio/contracts';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import type { ActiveExecution } from './types.js';
import {
  isAcceptedRunnerResultStatus,
  recoverSuccessFinalizations,
  type FinalizerDeps,
} from './workflow-execution-finalizer.js';
import { finalizeResolvedRunnerResult } from './workflow-runner-tasks.js';

/** Executor state and callbacks the authority runner result acceptance needs. */
export interface AuthorityRunnerResultDeps {
  /** Bus bound to the executor; every request is sent under the passed call context. */
  readonly bus: IMakaioBus;
  /** In-memory executions of the executor; a missing entry is adopted for the duration of the acceptance. */
  readonly activeExecutions: Map<string, ActiveExecution>;
  /** Builds the finalizer dependency bundle from current executor state. */
  readonly buildFinalizerDeps: () => FinalizerDeps;
  /**
   * Registers the workflow's success finalizer when it is not registered yet.
   * @param call - Call context for the submitted execution.
   * @param workflow - Workflow selecting the success finalizer.
   * @param executionId - Execution receiving the current result.
   * @returns Cleanup for a registration made here, or `undefined` when none was needed.
   */
  readonly registerResultFinalizer: (
    call: CallContext,
    workflow: WorkflowDefinition,
    executionId: string,
  ) => Promise<(() => void) | undefined>;
}

/**
 * Load and validate the durable run context and workflow definition of an
 * authority-owned execution.
 * @param call - Call context of the message that delivers the result.
 * @param bus - Bus used for the storage reads.
 * @param executionId - Durable authority-owned execution identity.
 * @param workflowId - Workflow identity the result claims.
 * @returns The run context and the matching workflow definition.
 * @throws When the run context or definition is missing, mismatched, or not authority-terminated.
 */
export async function loadAuthorityRunnerContext(
  call: CallContext,
  bus: IMakaioBus,
  executionId: string,
  workflowId: string,
) {
  const { runContext } = await bus.request(call, WorkflowStorageSubjects.getRunContext, { executionId });
  if (!runContext) throw new Error(`Authority runner run context not found: ${executionId}`);
  if (runContext.executionId !== executionId || runContext.workflowId !== workflowId) {
    throw new Error('authority runner run context identity mismatch');
  }
  if (runContext.terminalAuthority !== 'authority') {
    throw new Error('authority runner result requires terminalAuthority=authority');
  }
  const executableRunContext = requireExecutableRunContext(runContext);
  const workflow =
    executableRunContext.definitionSnapshot ??
    (await bus.request(call, WorkflowStorageSubjects.get, { id: executableRunContext.workflowId })).workflow;
  if (!workflow || workflow.id !== workflowId) {
    throw new Error('authority runner workflow definition is unavailable or mismatched');
  }
  return { runContext: executableRunContext, workflow };
}

/**
 * Accept a terminal result from an authority-dispatched runner that was not
 * launched through the executor's in-memory task registry.
 *
 * Durable execution and run-context rows remain the source of truth. A missing
 * active entry is adopted temporarily and the result goes through the same
 * runner-result finalization path used by executor-owned tasks.
 * @param call - Call context of the message that delivers the result.
 * @param deps - Executor state and callbacks.
 * @param executionId - Durable authority-owned execution identity.
 * @param result - Correlated terminal runner result.
 * @returns The durable status after acceptance, including pending success finalization.
 */
export async function acceptAuthorityRunnerResult(
  call: CallContext,
  deps: AuthorityRunnerResultDeps,
  executionId: string,
  result: WorkflowRunResult,
): Promise<{ accepted: boolean; status: WorkflowExecution['status'] }> {
  const { bus, activeExecutions } = deps;
  if (result.executionId !== executionId) throw new Error('authority runner result execution identity mismatch');
  const { execution } = await bus.request(call, WorkflowStorageSubjects.getExecution, { executionId });
  if (!execution) throw new Error(`Authority runner execution not found: ${executionId}`);
  if (execution.workflowId !== result.workflowId) throw new Error('authority runner result workflow identity mismatch');
  if (execution.status === 'cancelled' && result.status !== 'cancelled') {
    return { accepted: false, status: execution.status };
  }

  let replayCleanup: (() => void) | undefined;
  if (execution.status === 'finalizing') {
    const { workflow } = await loadAuthorityRunnerContext(call, bus, executionId, result.workflowId);
    replayCleanup = await deps.registerResultFinalizer(call, workflow, executionId);
  }
  const replayDeps = { ...deps.buildFinalizerDeps(), replayingExecutionId: executionId };
  const replayStatus = await resolveAuthorityRunnerReplay(call, replayDeps, execution, result).finally(() =>
    replayCleanup?.(),
  );
  if (replayStatus !== undefined) return { accepted: true, status: replayStatus };
  if (execution.status !== 'running') throw new Error(`Authority runner execution is ${execution.status}`);

  const { runContext, workflow } = await loadAuthorityRunnerContext(call, bus, executionId, result.workflowId);
  const unregisterFinalizer = await deps.registerResultFinalizer(call, workflow, executionId);

  const existing = activeExecutions.get(executionId);
  let adopted = false;
  if (!existing) {
    activeExecutions.set(executionId, {
      execution,
      workflow,
      runContext,
    });
    adopted = true;
  } else if (existing.execution.workflowId !== result.workflowId) {
    throw new Error('authority runner active execution identity mismatch');
  }
  try {
    await finalizeResolvedRunnerResult(
      call,
      {
        activeExecutions,
        buildFinalizerDeps: deps.buildFinalizerDeps,
      },
      result,
    );
  } finally {
    if (adopted) activeExecutions.delete(executionId);
    unregisterFinalizer?.();
  }
  const settled = await bus.request(call, WorkflowStorageSubjects.getExecution, { executionId });
  if (settled.execution?.status === 'cancelled' && result.status !== 'cancelled') {
    return { accepted: false, status: settled.execution.status };
  }
  if (!settled.execution || !isAcceptedRunnerResultStatus(settled.execution.status, result.status)) {
    throw new Error(`Authority runner result did not settle compatibly with ${result.status}`);
  }
  return { accepted: true, status: settled.execution.status };
}

/**
 * Resolve an already terminal runner result through existing success-finalizer recovery.
 * @param call - Call context of the work that replays the runner result.
 * @param deps - Owner storage and registered success finalizers.
 * @param execution - Durable execution read before result acceptance.
 * @param result - Correlated terminal workflow result.
 * @returns Compatible terminal status, or undefined for a not-yet-terminal owner.
 */
async function resolveAuthorityRunnerReplay(
  call: CallContext,
  deps: FinalizerDeps,
  execution: WorkflowExecution,
  result: WorkflowRunResult,
): Promise<WorkflowExecution['status'] | undefined> {
  if (execution.status === 'finalizing') {
    if (result.status !== 'completed') {
      throw new Error('authority runner result conflicts with terminal execution');
    }
    await recoverSuccessFinalizations(call, deps);
    const replayed = await deps.bus.request(call, WorkflowStorageSubjects.getExecution, { executionId: execution.id });
    if (!replayed.execution) throw new Error('Authority runner success finalization execution is missing');
    if (!isAcceptedRunnerResultStatus(replayed.execution.status, result.status)) {
      throw new Error('authority runner result conflicts with terminal execution');
    }
    return replayed.execution.status;
  }
  if (execution.status !== 'completed' && execution.status !== 'failed' && execution.status !== 'cancelled') {
    return undefined;
  }
  if (!isAcceptedRunnerResultStatus(execution.status, result.status))
    throw new Error('authority runner result conflicts with terminal execution');
  return execution.status;
}
