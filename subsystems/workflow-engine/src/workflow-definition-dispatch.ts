import type { IWorkflowRunner } from '@makaio/contracts';
import type { StartExecutionDeps } from './workflow-execution-start.js';
import { buildExecutionTask, type DefinitionRunnerTaskParams } from './workflow-runner-tasks.js';
import { createWorkerDispatchRunner } from './worker-dispatch-runner.js';

/** Selected execution mechanism, retained from initial persistence through launch. */
export interface DefinitionExecutionDispatch {
  /** Selected runner, or undefined for the in-process scheduler. */
  readonly runner: IWorkflowRunner | undefined;
}

/**
 * Select execution ownership and its runner together before persisting a run.
 * @param deps - Shared executor state and callbacks.
 * @param params - Workflow requirements, dispatch metadata, and any persisted completion owner.
 * @returns The exact runner instance that will launch this execution.
 */
export function selectDefinitionExecutionDispatch(
  deps: StartExecutionDeps,
  params: Pick<DefinitionRunnerTaskParams, 'workflow' | 'dispatchMetadata' | 'terminalAuthority'>,
): DefinitionExecutionDispatch {
  const runner =
    (deps.executionAttemptAuthority !== undefined
      ? createWorkerDispatchRunner({
          bus: deps.bus,
          requirements: params.workflow.requirements,
          dispatchMetadata: params.dispatchMetadata,
          authority: deps.executionAttemptAuthority,
        })
      : undefined) ?? deps.workflowRunner;
  // Fresh starts derive ownership from selection. Resume supplies its durable
  // owner and must not switch completion protocols when runner configuration changes.
  if (params.terminalAuthority !== undefined && params.terminalAuthority !== (runner?.terminalAuthority ?? 'worker')) {
    throw new Error('Selected workflow runner is incompatible with the persisted terminal authority');
  }
  return { runner };
}

/**
 * Launch a definition with its already-selected runner or in-process scheduler.
 * @param deps - Shared executor state and callbacks.
 * @param params - Bound execution data needed by the runner task.
 * @param dispatch - Selection retained from persistence, or selected here for resume callers.
 * @returns Settled execution task promise.
 */
export function launchDefinitionExecutionTask(
  deps: StartExecutionDeps,
  params: DefinitionRunnerTaskParams,
  dispatch: DefinitionExecutionDispatch = selectDefinitionExecutionDispatch(deps, params),
): Promise<void> {
  if (dispatch.runner !== undefined) {
    return buildExecutionTask(deps.buildRunnerTaskDeps(dispatch.runner), {
      ...params,
      terminalAuthority: params.terminalAuthority ?? dispatch.runner.terminalAuthority,
    });
  }
  return deps.runExecution(params.executionId).finally(() => {
    deps.executionTasks.delete(params.executionId);
  });
}
