import type { StartExecutionDeps } from './workflow-execution-start.js';
import { buildExecutionTask, type DefinitionRunnerTaskParams } from './workflow-runner-tasks.js';
import { createWorkerNodeDispatchRunner } from './worker-node-dispatch-runner.js';

/**
 * Dispatch a definition-backed execution through WorkerNode requirements, the
 * configured runner, or the in-process scheduler.
 * @param deps - Shared executor state and callbacks.
 * @param params - Bound execution data needed by the runner task.
 * @returns Settled execution task promise.
 */
export function launchDefinitionExecutionTask(
  deps: StartExecutionDeps,
  params: DefinitionRunnerTaskParams,
): Promise<void> {
  if (deps.executionAttemptAuthority !== undefined) {
    const workerNodeRunner = createWorkerNodeDispatchRunner({
      bus: deps.bus,
      requirements: params.workflow.requirements,
      dispatchMetadata: params.dispatchMetadata,
      authority: deps.executionAttemptAuthority,
    });
    if (workerNodeRunner !== undefined) {
      return buildExecutionTask(deps.buildRunnerTaskDeps(workerNodeRunner), {
        ...params,
        terminalAuthority: 'authority',
      });
    }
  }
  if (deps.workflowRunner !== undefined) {
    return buildExecutionTask(deps.buildRunnerTaskDeps(deps.workflowRunner), params);
  }
  return deps.runExecution(params.executionId).finally(() => {
    deps.executionTasks.delete(params.executionId);
  });
}
