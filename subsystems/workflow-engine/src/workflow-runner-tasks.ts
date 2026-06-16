import {
  WORKFLOW_CANCELLED_REASON,
  type IWorkflowRunner,
  type JsonValue,
  type SuspensionStrategy,
  type WorkflowDefinition,
  type WorkflowRunContext,
  type WorkflowRunnerRunOptions,
  type WorkflowRunResult,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import type { ActiveExecution, ExecutorConfig } from './types.js';
import type { FinalizerDeps } from './workflow-execution-finalizer.js';
import {
  cancelExecution,
  completeExecutionWithFailure,
  completeExecutionWithSuccess,
} from './workflow-execution-finalizer.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import { WorkflowSubjects } from './namespace.js';

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
 * Bind caller-supplied inputs for a workflow execution.
 *
 * The primitive runtime uses a JSON Schema (`inputSchema`) for input validation.
 * At execution start we preserve the caller-supplied JSON value as-is so
 * object, array, and scalar input schemas all reach the runtime unchanged.
 * @param _workflow - Workflow definition (reserved for future schema-based validation).
 * @param provided - Caller-supplied input values.
 * @returns Bound input value.
 */
export function bindWorkflowInputs(_workflow: Pick<WorkflowDefinition, 'inputSchema'>, provided: JsonValue): JsonValue {
  return provided;
}

/**
 * Bind caller-supplied configuration for a workflow execution.
 *
 * Mirrors input binding: schema validation is handled at authoring/UI seams for
 * now, while the runtime receives a plain object available as `config.*` in
 * expressions and station contexts.
 * @param _workflow - Workflow definition (reserved for future schema-based validation).
 * @param provided - Caller-supplied configuration values.
 * @returns Bound configuration record.
 */
export function bindWorkflowConfig(
  _workflow: Pick<WorkflowDefinition, 'configSchema'>,
  provided: Record<string, unknown>,
): Record<string, unknown> {
  return { ...provided };
}

/**
 * Convert an AbortSignal reason into a stable cancellation reason string.
 * @param signal - AbortSignal attached to the workflow-level runner.
 * @returns Human-readable cancellation reason.
 */
function runnerCancellationReason(signal: AbortSignal): string {
  if (signal.reason instanceof Error) {
    return signal.reason.message;
  }
  if (typeof signal.reason === 'string' && signal.reason.length > 0) {
    return signal.reason;
  }
  return WORKFLOW_CANCELLED_REASON;
}

/**
 * Cancel durable execution state when runner dispatch aborts before worker ownership.
 *
 * Workflow-level runners own finalization after the worker orchestrator starts.
 * If dispatch/preparation/readiness rejects from a cancellation before the worker
 * can persist terminal state, storage still contains the parent executor's initial
 * `running` record. This helper reads storage first to avoid overwriting a worker
 * that has already terminalized the execution.
 * @param deps - Runner task dependencies.
 * @param executionId - Workflow execution identifier.
 * @param signal - Runner AbortSignal that has already been aborted.
 */
async function cancelRunningExecutionAfterRunnerAbort(
  deps: RunnerTaskDeps,
  executionId: string,
  signal: AbortSignal,
): Promise<void> {
  const active = deps.activeExecutions.get(executionId);
  if (!active || active.execution.status !== 'running') return;

  const finalizerDeps = deps.buildFinalizerDeps();
  const { execution } = await finalizerDeps.bus.request(WorkflowStorageSubjects.getExecution, {
    executionId,
  });
  if (execution?.status !== 'running') return;

  // Refresh the in-memory execution state from the durable snapshot so the
  // finalizer sees the latest status before issuing the cancellation.
  active.execution = execution;
  const cancelled = await cancelExecution(finalizerDeps, executionId, runnerCancellationReason(signal));
  if (!cancelled) {
    console.error(`[WorkflowExecutor] Failed to persist runner cancellation for ${executionId}: execution not active`);
  }
}

/**
 * Transition a paused execution to the `paused` storage status and emit
 * `execution.paused` when the host executor still sees a `running` execution.
 *
 * This is the host-side complement to the orchestrator's
 * `persistPausedExecution`. When an isolated runner (Piscina thread, Docker
 * container, remote worker) returns a `paused` result the orchestrator has
 * already updated storage and emitted the event on its own bus connection. When
 * storage is already paused, this helper releases active executor ownership
 * without writing duplicate storage rows or emitting duplicate events.
 *
 * For stub runners used in tests (or future runners that return paused results
 * without running the orchestrator), the host executor still holds a `running`
 * execution and must perform the state transition itself.
 * @param deps - Runner task dependencies.
 * @param result - Paused runner result carrying gate identity.
 */
async function parkExecution(deps: RunnerTaskDeps, result: WorkflowRunResult): Promise<void> {
  if (result.pausedAtGateId === undefined || result.pausedAtFrameId === undefined) {
    throw new Error(`Paused runner result for '${result.executionId}' is missing gate identity`);
  }
  const { bus } = deps.buildFinalizerDeps();
  const { execution } = await bus.request(WorkflowStorageSubjects.getExecution, { executionId: result.executionId });
  if (execution?.status !== 'running') {
    const active = deps.activeExecutions.get(result.executionId);
    if (active !== undefined && execution?.status === 'paused') {
      active.execution.status = 'paused';
      deps.activeExecutions.delete(result.executionId);
    }
    return;
  }
  const pausedExecution = { ...execution, status: 'paused' as const };
  await bus.request(WorkflowStorageSubjects.setExecution, { execution: pausedExecution });
  const active = deps.activeExecutions.get(result.executionId);
  if (active !== undefined) {
    active.execution = pausedExecution;
  }
  await bus.emit(WorkflowSubjects.execution.paused, {
    executionId: result.executionId,
    workflowId: result.workflowId,
    pausedAtGateId: result.pausedAtGateId,
    pausedAtFrameId: result.pausedAtFrameId,
  });
  deps.activeExecutions.delete(result.executionId);
}

/**
 * Persist terminal state from a resolved workflow runner result when the local
 * executor still owns the execution.
 *
 * Remote runners that write durable lifecycle state themselves remove the
 * active execution through the finalizer before this fallback observes it.
 * Providers that only return a terminal result, such as externally observed
 * GitHub Actions runs, still need the host executor to persist that result.
 * @param deps - Runner task dependencies.
 * @param result - Terminal result returned by the workflow runner.
 */
async function finalizeResolvedRunnerResult(deps: RunnerTaskDeps, result: WorkflowRunResult): Promise<void> {
  const active = deps.activeExecutions.get(result.executionId);
  if (!active || active.execution.status !== 'running') return;

  const finalizerDeps = deps.buildFinalizerDeps();
  const { execution } = await finalizerDeps.bus.request(WorkflowStorageSubjects.getExecution, {
    executionId: result.executionId,
  });
  if (execution?.status !== 'running') return;

  active.execution = execution;
  if (result.status === 'completed') {
    await completeExecutionWithSuccess(finalizerDeps, active.execution, result.executionId, active.execution.startedAt);
    return;
  }
  if (result.status === 'cancelled') {
    await cancelExecution(finalizerDeps, result.executionId, result.reason ?? WORKFLOW_CANCELLED_REASON);
    return;
  }
  if (result.status === 'failed') {
    await completeExecutionWithFailure(finalizerDeps, active.execution, result.executionId, result.error);
    return;
  }
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
 * Parameters for building a workflow runner task from a storage-backed definition.
 *
 * Used by {@link buildExecutionTask} and reconstructed from a persisted
 * {@link WorkflowRunContext} when resuming a paused execution.
 */
export interface DefinitionRunnerTaskParams {
  executionId: string;
  workflowId: string;
  workflow: WorkflowDefinition;
  source: WorkflowWorkerConfig['source'];
  coordinatorSessionId: string;
  sanitizedTriggerPayload: Record<string, unknown>;
  boundInputs: JsonValue;
  boundConfig: Record<string, unknown>;
  artifactRef?: WorkflowWorkerConfig['artifactRef'];
  executionHints?: WorkflowWorkerConfig['executionHints'];
  scope: WorkflowDefinition['scope'];
  workspaceRoot: string;
  /**
   * Suspension strategy persisted from the original run context.
   *
   * Forwarded to the worker config so resumed executions inherit the same
   * provider suspension behavior as the initial dispatch. Defaults to
   * `'wait-in-process'` when absent (executions started before this field
   * was introduced).
   */
  readonly suspensionStrategy?: SuspensionStrategy;
  /**
   * Opaque metadata forwarded to the WorkerNode dispatch request.
   *
   * Used by the resume path to signal `{ resume: true }` so providers
   * applying `exit-and-redispatch` can apply the correct re-dispatch strategy.
   */
  dispatchMetadata?: Record<string, unknown>;
}

/**
 * Build the async task for a file-based workflow execution.
 *
 * Delegates to the configured {@link IWorkflowRunner} with a `path`-sourced
 * {@link WorkflowWorkerConfig}. The runner is responsible for loading the file
 * and managing the full execution lifecycle. If the runner returns a terminal
 * result without having already finalized durable state, the host executor
 * persists that result as a fallback.
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
    config: {},
    scope,
    busUrl: config.busUrl,
    busAuth: config.busAuth,
    context: deps.resolveWorkflowContext(workspaceRoot),
    env: config.platformDefaults.env ?? {},
    coordinatorSessionId,
    cancelSubject: `workflow.${executionId}.cancel`,
    suspensionStrategy: 'wait-in-process',
  };

  return Promise.resolve()
    .then(() => workflowRunner.run(workerConfig, controller.signal))
    .then(async (result) => {
      if (result.status === 'paused') {
        await parkExecution(deps, result);
        return;
      }
      await finalizeResolvedRunnerResult(deps, result);
    })
    .catch(async (error: unknown) => {
      if (controller.signal.aborted) {
        await cancelRunningExecutionAfterRunnerAbort(deps, executionId, controller.signal).catch(
          (persistError: unknown) => {
            console.error(
              `[WorkflowExecutor] Failed to persist file runner cancellation for ${executionId}:`,
              persistError,
            );
          },
        );
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
 * Build the worker config for a storage-backed workflow runner task.
 * @param deps - Runner task dependencies.
 * @param params - Bound execution data for this task.
 * @returns Fully populated worker configuration.
 */
function buildDefinitionWorkerConfig(deps: RunnerTaskDeps, params: DefinitionRunnerTaskParams): WorkflowWorkerConfig {
  const { config } = deps;
  return {
    source: params.source,
    definition: params.workflow,
    executionId: params.executionId,
    workflowId: params.workflowId,
    triggerPayload: params.sanitizedTriggerPayload,
    inputs: params.boundInputs,
    config: params.boundConfig,
    ...(params.artifactRef !== undefined ? { artifactRef: params.artifactRef } : {}),
    ...(params.executionHints !== undefined ? { executionHints: params.executionHints } : {}),
    scope: params.scope,
    busUrl: config.busUrl,
    busAuth: config.busAuth,
    context: deps.resolveWorkflowContext(params.workspaceRoot),
    env: config.platformDefaults.env ?? {},
    coordinatorSessionId: params.coordinatorSessionId,
    cancelSubject: `workflow.${params.executionId}.cancel`,
    suspensionStrategy: params.suspensionStrategy ?? 'wait-in-process',
  };
}

/**
 * Build the async task that drives a storage-backed workflow execution via a
 * workflow-level runner.
 *
 * Delegates to the configured {@link IWorkflowRunner} with a newly minted
 * AbortController (tracked in `workflowAbortControllers` for cancellation).
 * If the runner returns a terminal result without having already finalized
 * durable state, the host executor persists that result as a fallback.
 * The caller is responsible for ensuring a runner is present before invoking
 * this function (i.e. use the in-process path when `workflowRunner` is absent).
 * @param deps - Runner task dependencies.
 * @param params - Identifiers, pre-computed execution data, and the workflow definition.
 * @returns Settled Promise tracked in `executionTasks`.
 */
export function buildExecutionTask(deps: RunnerTaskDeps, params: DefinitionRunnerTaskParams): Promise<void> {
  const { executionId } = params;
  const { workflowRunner, workflowAbortControllers, executionTasks, activeExecutions } = deps;

  const controller = new AbortController();
  workflowAbortControllers.set(executionId, controller);

  const workerConfig = buildDefinitionWorkerConfig(deps, params);
  const runOptions: WorkflowRunnerRunOptions | undefined =
    params.dispatchMetadata === undefined ? undefined : { dispatchMetadata: params.dispatchMetadata };

  return Promise.resolve()
    .then(() => workflowRunner.run(workerConfig, controller.signal, undefined, runOptions))
    .then(async (result) => {
      if (result.status === 'paused') {
        await parkExecution(deps, result);
        return;
      }
      await finalizeResolvedRunnerResult(deps, result);
    })
    .catch(async (error: unknown) => {
      if (controller.signal.aborted) {
        await cancelRunningExecutionAfterRunnerAbort(deps, executionId, controller.signal).catch(
          (persistError: unknown) => {
            console.error(`[WorkflowExecutor] Failed to persist runner cancellation for ${executionId}:`, persistError);
          },
        );
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

/**
 * Reconstruct {@link DefinitionRunnerTaskParams} from a persisted
 * {@link WorkflowRunContext} and the corresponding workflow definition.
 *
 * Used by the resume path in {@link WorkflowExecutor} to re-dispatch a paused
 * execution through the same runner infrastructure as an initial dispatch,
 * without requiring the caller to reconstruct every field manually.
 *
 * The `options.resume` flag merges the durable run-context dispatch metadata
 * with `{ resume: true }` so WorkerNode dispatch runners can signal the
 * provider that this is a resume, not a fresh dispatch, without dropping the
 * original dispatch target identity. In-process runners ignore it.
 * @param runContext - Persisted run-context snapshot for the paused execution.
 * @param workflow - Workflow definition for the execution.
 * @param options - Optional flags; set `resume: true` for resumed executions.
 * @returns Fully populated runner task params ready for execution dispatch.
 */
export function buildDefinitionRunnerParamsFromRunContext(
  runContext: WorkflowRunContext,
  workflow: WorkflowDefinition,
  options: { readonly resume?: boolean } = {},
): DefinitionRunnerTaskParams {
  const dispatchMetadata = buildRunContextDispatchMetadata(runContext, options);

  return {
    executionId: runContext.executionId,
    workflowId: runContext.workflowId,
    workflow,
    source: runContext.source,
    coordinatorSessionId: runContext.coordinatorSessionId,
    sanitizedTriggerPayload: runContext.triggerPayload,
    boundInputs: runContext.inputs,
    boundConfig: runContext.config ?? {},
    ...(runContext.artifactRef !== undefined ? { artifactRef: runContext.artifactRef } : {}),
    ...(runContext.executionHints !== undefined ? { executionHints: runContext.executionHints } : {}),
    scope: runContext.scope,
    workspaceRoot: runContext.context.repoPath,
    suspensionStrategy: runContext.suspensionStrategy,
    ...(dispatchMetadata !== undefined ? { dispatchMetadata } : {}),
  };
}

/**
 * Build dispatch metadata for a task reconstructed from durable run context.
 * @param runContext - Persisted run-context snapshot for the execution.
 * @param options - Resume options for the reconstructed dispatch.
 * @returns Metadata to forward to the runner, or undefined when no metadata is required.
 */
function buildRunContextDispatchMetadata(
  runContext: WorkflowRunContext,
  options: { readonly resume?: boolean },
): Record<string, unknown> | undefined {
  if (options.resume === true) {
    return { ...runContext.dispatchMetadata, resume: true };
  }
  return runContext.dispatchMetadata;
}
