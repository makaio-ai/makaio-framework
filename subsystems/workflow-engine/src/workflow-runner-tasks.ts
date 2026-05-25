import type { IWorkflowRunner, WorkflowDefinition, WorkflowWorkerConfig } from '@makaio/contracts';
import type { ActiveExecution, ExecutorConfig } from './types.js';
import type { FinalizerDeps } from './workflow-execution-finalizer.js';
import { completeExecutionWithFailure } from './workflow-execution-finalizer.js';

/** OS values accepted by {@link WorkflowWorkerConfig}. */
export type WorkerOs = 'darwin' | 'linux' | 'win32';

/** OS values recognised by the workflow worker config schema. */
const SUPPORTED_WORKER_OS: readonly WorkerOs[] = ['darwin', 'linux', 'win32'];

/**
 * Map a Node.js `process.platform` value to a {@link WorkerOs}.
 *
 * Platforms not in the allowlist fall back to `'linux'` — the most
 * portable assumption for unknown POSIX-like environments.
 * @param platform - Raw `process.platform` value.
 * @returns Validated worker OS discriminant.
 */
export function resolveWorkerOs(platform: string): WorkerOs {
  const found = SUPPORTED_WORKER_OS.find((supported) => supported === platform);
  return found ?? 'linux';
}

/**
 * Merge provided inputs with workflow input definitions, applying defaults and
 * throwing for missing required inputs.
 * @param definitions - Workflow input parameter definitions.
 * @param provided - Caller-supplied input values.
 * @returns Bound input record with defaults applied.
 */
export function bindWorkflowInputs(
  definitions: WorkflowDefinition['inputs'] | undefined,
  provided: Record<string, unknown>,
): Record<string, unknown> {
  const bound: Record<string, unknown> = {};

  for (const input of definitions ?? []) {
    if (Object.prototype.hasOwnProperty.call(provided, input.name)) {
      bound[input.name] = provided[input.name];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'default')) {
      bound[input.name] = input.default;
      continue;
    }
    if (input.required) {
      throw new Error(`Missing required workflow input: ${input.name}`);
    }
  }

  for (const [key, value] of Object.entries(provided)) {
    if (!Object.prototype.hasOwnProperty.call(bound, key)) {
      bound[key] = value;
    }
  }

  return bound;
}

/**
 * Dependencies injected into runner task builders.
 *
 * Bundles the executor state and callbacks needed by
 * {@link buildExecutionTask} and {@link buildFileExecutionTask} so those
 * functions can be kept out of the {@link WorkflowExecutor} class body.
 */
export interface RunnerTaskDeps {
  /** Configured workflow-level runner (always defined at these call sites). */
  workflowRunner: IWorkflowRunner;
  /** Per-execution abort controllers used for cooperative cancellation. */
  workflowAbortControllers: Map<string, AbortController>;
  /** Settled execution task promises tracked for shutdown draining. */
  executionTasks: Map<string, Promise<void>>;
  /** Live execution registry shared with the finalizer and scheduler. */
  activeExecutions: Map<string, ActiveExecution>;
  /** Factory that produces a {@link FinalizerDeps} snapshot from executor state. */
  buildFinalizerDeps: () => FinalizerDeps;
  /**
   * Build worker context for an execution workspace.
   * @param workspaceRoot - Resolved workspace root for this execution.
   */
  resolveWorkflowContext: (workspaceRoot: string) => WorkflowWorkerConfig['context'];
  /** Executor configuration. */
  config: ExecutorConfig;
}

/**
 * Build the async task for a file-based workflow execution.
 *
 * Delegates to the configured {@link IWorkflowRunner} with a `path`-sourced
 * {@link WorkflowWorkerConfig}. The runner is responsible for loading the file
 * and managing the full execution lifecycle.
 * @param deps - Runner task dependencies.
 * @param params - Identifiers and pre-computed execution data.
 * @returns Settled Promise tracked in `executionTasks`.
 */
export function buildFileExecutionTask(
  deps: RunnerTaskDeps,
  params: {
    executionId: string;
    workflowId: string;
    filePath: string;
    coordinatorSessionId: string;
    sanitizedTriggerPayload: Record<string, unknown>;
    scope: WorkflowDefinition['scope'];
    workspaceRoot: string;
  },
): Promise<void> {
  const { executionId, workflowId, filePath, coordinatorSessionId, sanitizedTriggerPayload, scope, workspaceRoot } =
    params;
  const { workflowRunner, workflowAbortControllers, executionTasks, activeExecutions, config } = deps;

  const controller = new AbortController();
  workflowAbortControllers.set(executionId, controller);

  const workerConfig: WorkflowWorkerConfig = {
    source: { kind: 'path', path: filePath },
    executionId,
    workflowId,
    triggerPayload: sanitizedTriggerPayload,
    inputs: {},
    scope,
    busUrl: config.busUrl,
    busAuth: config.busAuth,
    context: deps.resolveWorkflowContext(workspaceRoot),
    env: config.platformDefaults.env ?? {},
    coordinatorSessionId,
    cancelSubject: `workflow.${executionId}.cancel`,
  };

  return Promise.resolve()
    .then(() => workflowRunner.run(workerConfig, controller.signal))
    .then(() => {
      // A resolved workflow runner owns the durable execution lifecycle. The
      // executor only finalizes here when dispatch rejects before the worker can
      // persist terminal state; re-finalizing resolved results would duplicate
      // worker-emitted lifecycle events.
      return undefined;
    })
    .catch(async (error: unknown) => {
      if (controller.signal.aborted) {
        return;
      }
      const active = activeExecutions.get(executionId);
      if (active) {
        const message = error instanceof Error ? error.message : String(error);
        await completeExecutionWithFailure(deps.buildFinalizerDeps(), active.execution, executionId, message).catch(
          (persistError: unknown) => {
            console.error(
              `[WorkflowExecutor] Failed to persist file runner boot failure for ${executionId}:`,
              persistError,
            );
          },
        );
      }
    })
    .finally(() => {
      workflowAbortControllers.delete(executionId);
      executionTasks.delete(executionId);
      activeExecutions.delete(executionId);
    });
}

/**
 * Build the async task that drives a storage-backed workflow execution via a
 * workflow-level runner.
 *
 * Delegates to the configured {@link IWorkflowRunner} with a newly minted
 * AbortController (tracked in `workflowAbortControllers` for cancellation).
 * The caller is responsible for ensuring a runner is present before invoking
 * this function (i.e. use the in-process path when `workflowRunner` is absent).
 * @param deps - Runner task dependencies.
 * @param params - Identifiers, pre-computed execution data, and the workflow definition.
 * @returns Settled Promise tracked in `executionTasks`.
 */
export function buildExecutionTask(
  deps: RunnerTaskDeps,
  params: {
    executionId: string;
    workflowId: string;
    workflow: WorkflowDefinition;
    coordinatorSessionId: string;
    sanitizedTriggerPayload: Record<string, unknown>;
    boundInputs: Record<string, unknown>;
    scope: WorkflowDefinition['scope'];
    workspaceRoot: string;
  },
): Promise<void> {
  const {
    executionId,
    workflowId,
    workflow,
    coordinatorSessionId,
    sanitizedTriggerPayload,
    boundInputs,
    scope,
    workspaceRoot,
  } = params;
  const { workflowRunner, workflowAbortControllers, executionTasks, activeExecutions, config } = deps;

  const controller = new AbortController();
  workflowAbortControllers.set(executionId, controller);

  const workerConfig: WorkflowWorkerConfig = {
    source: { kind: 'definition', workflowId },
    definition: workflow,
    executionId,
    workflowId,
    triggerPayload: sanitizedTriggerPayload,
    inputs: boundInputs,
    scope,
    busUrl: config.busUrl,
    busAuth: config.busAuth,
    context: deps.resolveWorkflowContext(workspaceRoot),
    env: config.platformDefaults.env ?? {},
    coordinatorSessionId,
    cancelSubject: `workflow.${executionId}.cancel`,
  };

  return Promise.resolve()
    .then(() => workflowRunner.run(workerConfig, controller.signal))
    .then(() => {
      // A resolved workflow runner owns the durable execution lifecycle. The
      // executor only finalizes here when dispatch rejects before the worker can
      // persist terminal state; re-finalizing resolved results would duplicate
      // worker-emitted lifecycle events.
      return undefined;
    })
    .catch(async (error: unknown) => {
      if (controller.signal.aborted) {
        return;
      }
      // The runner rejected before the worker could manage the execution
      // lifecycle. Persist a failed status so the execution does not stay
      // stuck as 'running' in storage indefinitely.
      const active = activeExecutions.get(executionId);
      if (active) {
        const message = error instanceof Error ? error.message : String(error);
        await completeExecutionWithFailure(deps.buildFinalizerDeps(), active.execution, executionId, message).catch(
          (persistError: unknown) => {
            console.error(`[WorkflowExecutor] Failed to persist runner boot failure for ${executionId}:`, persistError);
          },
        );
      }
    })
    .finally(() => {
      workflowAbortControllers.delete(executionId);
      executionTasks.delete(executionId);
      // Remove from active executions in case the runner completed without
      // calling a lifecycle finalizer (e.g., resolved without persisting
      // completed/failed/cancelled). The finalizer already removes the entry
      // on the success/failure paths; deleting a missing key is a no-op.
      activeExecutions.delete(executionId);
    });
}
