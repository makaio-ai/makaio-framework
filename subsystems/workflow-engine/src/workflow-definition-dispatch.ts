import type { IWorkflowRunner } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import type { ResolvedDefinitionStartOptions, StartExecutionDeps } from './workflow-execution-start.js';
import { buildExecutionTask, type DefinitionRunnerTaskParams } from './workflow-runner-tasks.js';

/** Selected execution mechanism, retained from initial persistence through launch. */
export interface DefinitionExecutionDispatch {
  /** Selected runner, or undefined for the in-process scheduler. */
  readonly runner: IWorkflowRunner | undefined;
}

/**
 * Select execution ownership and its runner together before persisting a run.
 * @param call - Context of the request starting the definition.
 * @param deps - Shared executor state and callbacks.
 * @param executionId - Generated execution identity.
 * @param options - Resolved workflow and any host-owned file replay selection.
 * @returns The exact runner instance that will launch this execution.
 */
export function selectDefinitionExecutionDispatch(
  call: CallContext,
  deps: Pick<StartExecutionDeps, 'workflowRunner' | 'workflowRunnerSelector' | 'callerLocalFileRunner'>,
  executionId: string,
  options: Pick<ResolvedDefinitionStartOptions, 'workflow' | 'hostFileReplay'>,
): DefinitionExecutionDispatch {
  const fileRunner = options.hostFileReplay ? deps.callerLocalFileRunner : undefined;
  const requirements = options.workflow.requirements;
  return {
    runner: fileRunner ?? deps.workflowRunnerSelector?.(call, { executionId, requirements }) ?? deps.workflowRunner,
  };
}

/**
 * Launch a definition with its already-selected runner or in-process scheduler.
 * @param call - Call context of the message that triggered this execution.
 * @param deps - Shared executor state and callbacks.
 * @param params - Bound execution data needed by the runner task.
 * @param dispatch - Selection retained from initial persistence.
 * @returns Settled execution task promise.
 */
export function launchDefinitionExecutionTask(
  call: CallContext,
  deps: StartExecutionDeps,
  params: Omit<DefinitionRunnerTaskParams, 'terminalAuthority'>,
  dispatch: DefinitionExecutionDispatch,
): Promise<void> {
  if (dispatch.runner !== undefined) {
    return buildExecutionTask(call, deps.buildRunnerTaskDeps(dispatch.runner), {
      ...params,
      terminalAuthority: dispatch.runner.terminalAuthority,
    });
  }
  return deps.runExecution(call, params.executionId);
}
