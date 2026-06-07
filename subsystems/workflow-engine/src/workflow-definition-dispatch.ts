import type { StartExecutionDeps } from './workflow-execution-start.js';
import { buildExecutionTask, type DefinitionRunnerTaskParams } from './workflow-runner-tasks.js';
import { createExecutionHintWorkerNodeRunner } from './worker-node-dispatch-runner.js';

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
  const workerNodeRunner = createExecutionHintWorkerNodeRunner(
    deps.bus,
    params.executionHints,
    params.dispatchMetadata,
  );
  if (workerNodeRunner !== undefined) {
    return buildExecutionTask(deps.buildRunnerTaskDeps(workerNodeRunner), params);
  }
  if (deps.workflowRunner !== undefined) {
    return buildExecutionTask(deps.buildRunnerTaskDeps(deps.workflowRunner), params);
  }
  return deps.runExecution(params.executionId).finally(() => {
    deps.executionTasks.delete(params.executionId);
  });
}
