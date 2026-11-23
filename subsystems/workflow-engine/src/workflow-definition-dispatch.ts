import type { IWorkflowRunner } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import type { StartExecutionDeps } from './workflow-execution-start.js';
import type { WorkflowRunnerSelectionInput } from './workflow-runner-selector.js';
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
 * @param input - Execution identity and declared requirements.
 * @returns The exact runner instance that will launch this execution.
 */
export function selectDefinitionExecutionDispatch(
  call: CallContext,
  deps: Pick<StartExecutionDeps, 'workflowRunner' | 'workflowRunnerSelector'>,
  input: WorkflowRunnerSelectionInput,
): DefinitionExecutionDispatch {
  return { runner: deps.workflowRunnerSelector?.(call, input) ?? deps.workflowRunner };
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
