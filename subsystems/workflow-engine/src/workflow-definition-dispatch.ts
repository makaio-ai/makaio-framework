import type {
  JsonValue,
  WorkflowDefinition,
  WorkflowExecutionScope,
  WorkflowRunContext,
  WorkflowWorkerSource,
} from '@makaio/contracts';
import type { StartExecutionDeps } from './workflow-execution-start.js';
import { buildExecutionTask } from './workflow-runner-tasks.js';
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
  params: {
    executionId: string;
    workflowId: string;
    workflow: WorkflowDefinition;
    source: WorkflowWorkerSource;
    coordinatorSessionId: string;
    sanitizedTriggerPayload: Record<string, unknown>;
    boundInputs: JsonValue;
    boundConfig: Record<string, unknown>;
    artifactRef?: WorkflowRunContext['artifactRef'];
    executionHints?: WorkflowRunContext['executionHints'];
    scope: WorkflowExecutionScope;
    workspaceRoot: string;
  },
): Promise<void> {
  const workerNodeRunner = createExecutionHintWorkerNodeRunner(deps.bus, params.executionHints);
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
