import {
  WORKFLOW_CANCELLED_REASON,
  type IWorkflowRunner,
  type JsonValue,
  type WorkflowDefinition,
  type WorkflowRunContext,
  type WorkflowTriggerMode,
  type WorkflowRunnerCompletion,
  type WorkflowRunnerRunOptions,
  type WorkflowRunResult,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import { MakaioError, type CallContext } from '@makaio/core';
import type { ActiveExecution, ExecutorConfig } from './types.js';
import type { FinalizerDeps } from './workflow-execution-finalizer.js';
import {
  cancelExecution,
  completeExecutionWithFailure,
  completeExecutionWithSuccess,
  withExecutionDurableTransition,
} from './workflow-execution-finalizer.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';

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
 * expressions and code step contexts.
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
 * @param call - Call context of the message that triggered this execution.
 * @param deps - Runner task dependencies.
 * @param executionId - Workflow execution identifier.
 * @param signal - Runner AbortSignal that has already been aborted.
 */
async function cancelRunningExecutionAfterRunnerAbort(
  call: CallContext,
  deps: RunnerTaskDeps,
  executionId: string,
  signal: AbortSignal,
): Promise<void> {
  const active = deps.activeExecutions.get(executionId);
  if (!active || active.execution.status !== 'running') return;

  const finalizerDeps = deps.buildFinalizerDeps();
  const { execution } = await finalizerDeps.bus.request(call, WorkflowStorageSubjects.getExecution, {
    executionId,
  });
  if (execution?.status !== 'running') return;

  // Refresh the in-memory execution state from the durable snapshot so the
  // finalizer sees the latest status before issuing the cancellation.
  active.execution = execution;
  const cancelled = await cancelExecution(call, finalizerDeps, executionId, runnerCancellationReason(signal));
  if (!cancelled) {
    console.error(`[WorkflowExecutor] Failed to persist runner cancellation for ${executionId}: execution not active`);
  }
}

/**
 * Persist terminal state from a resolved workflow runner result when the local
 * executor still owns the execution.
 *
 * Remote runners that write durable lifecycle state themselves remove the
 * active execution through the finalizer before this fallback observes it.
 * Providers that only return a terminal result, such as externally observed
 * GitHub Actions runs, still need the host executor to persist that result.
 * @param call - Call context of the message that triggered this execution.
 * @param deps - Runner task dependencies.
 * @param result - Terminal result returned by the workflow runner.
 */
export async function finalizeResolvedRunnerResult(
  call: CallContext,
  deps: Pick<RunnerTaskDeps, 'activeExecutions' | 'buildFinalizerDeps'>,
  result: WorkflowRunResult,
): Promise<void> {
  const active = deps.activeExecutions.get(result.executionId);
  if (!active || active.execution.status !== 'running') return;

  const finalizerDeps = deps.buildFinalizerDeps();
  const { execution } = await finalizerDeps.bus.request(call, WorkflowStorageSubjects.getExecution, {
    executionId: result.executionId,
  });
  if (execution?.status !== 'running') return;

  active.execution = execution;
  if (result.status === 'completed') {
    await completeExecutionWithSuccess(
      call,
      finalizerDeps,
      active.execution,
      result.executionId,
      active.execution.startedAt,
    );
    return;
  }
  if (result.status === 'cancelled') {
    await cancelExecution(call, finalizerDeps, result.executionId, result.reason ?? WORKFLOW_CANCELLED_REASON);
    return;
  }
  if (result.status === 'failed') {
    await completeExecutionWithFailure(call, finalizerDeps, active.execution, result.executionId, result.error);
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
  /** Executor configuration. */
  config: ExecutorConfig;
}

/**
 * Parameters for building a workflow runner task from a storage-backed definition.
 *
 * Used by {@link buildExecutionTask} after a definition-backed start.
 */
export interface DefinitionRunnerTaskParams {
  executionId: string;
  workflowId: string;
  workflow: WorkflowDefinition;
  definitionSnapshot?: WorkflowDefinition;
  source: WorkflowWorkerConfig['source'];
  coordinatorSessionId: string;
  sanitizedTriggerPayload: Record<string, unknown>;
  boundInputs: JsonValue;
  boundConfig: Record<string, unknown>;
  artifactRef?: WorkflowWorkerConfig['artifactRef'];
  scope: WorkflowDefinition['scope'];
  /** Portable workspace reference for a path-backed source. */
  materializationSpec?: WorkflowWorkerConfig['materializationSpec'];
  /** Component that owns the execution's durable terminal transition. */
  readonly terminalAuthority?: WorkflowWorkerConfig['terminalAuthority'];
}

/** Parameters for building a workflow runner task from a file source. */
export interface FileRunnerTaskParams {
  executionId: string;
  workflowId: string;
  filePath: string;
  coordinatorSessionId: string;
  sanitizedTriggerPayload: Record<string, unknown>;
  /** Whether the worker executes immediately or waits for a declared trigger. */
  triggerMode: WorkflowTriggerMode;
  boundInputs: JsonValue;
  boundConfig: Record<string, unknown>;
  artifactRef?: WorkflowWorkerConfig['artifactRef'];
  scope: WorkflowDefinition['scope'];
  materializationSpec: NonNullable<WorkflowRunContext['materializationSpec']>;
}

/**
 * Handle a runner completion envelope by dispatching based on commitment state.
 *
 * - `uncommitted`: the runner produced the result but durable lifecycle
 *   transition has not been performed. The host executor must finalize
 *   the result.
 * - `authority-committed`: the Authority outcome RPC has converged canonical
 *   state. The runner task only cleans up its local bookkeeping.
 * - `authority-recorded-only`: the owner accepted a technical fact without a
 *   lifecycle projection. Release local task bookkeeping only.
 * @param call - Call context of the message that triggered this execution.
 * @param deps - Runner task dependencies.
 * @param completion - Completion envelope returned by the runner.
 * @param config - Identity bound to this runner invocation.
 * @param ownedExecution - Active entry captured before invoking the runner.
 */
async function handleRunnerCompletion(
  call: CallContext,
  deps: RunnerTaskDeps,
  completion: WorkflowRunnerCompletion,
  config: Pick<WorkflowWorkerConfig, 'executionId' | 'workflowId'>,
  ownedExecution: ActiveExecution | undefined,
): Promise<void> {
  const identity = completion.state === 'authority-recorded-only' ? completion : completion.result;
  if (identity.executionId !== config.executionId || identity.workflowId !== config.workflowId) {
    throw new Error(`Runner completion does not match its invocation '${config.executionId}'`);
  }
  // Authority acceptance is already the owner's decision. Cleanup belongs to
  // this task's finally block, which checks invocation ownership.
  if (completion.state !== 'uncommitted') return;
  if (deps.activeExecutions.get(config.executionId) !== ownedExecution) return;

  // Uncommitted: host executor owns finalization.
  await finalizeResolvedRunnerResult(call, deps, completion.result);
}

/**
 * Release only bookkeeping still owned by this invocation.
 * @param deps - Shared task registries.
 * @param executionId - Logical execution identifier.
 * @param active - Original active execution entry.
 * @param controller - This invocation's cancellation controller.
 */
function releaseRunnerTask(
  deps: RunnerTaskDeps,
  executionId: string,
  active: ActiveExecution | undefined,
  controller: AbortController,
): void {
  if (deps.activeExecutions.get(executionId) === active) deps.activeExecutions.delete(executionId);
  if (deps.workflowAbortControllers.get(executionId) === controller) deps.workflowAbortControllers.delete(executionId);
}

/**
 * Build the worker configuration for a file-based workflow runner task.
 * @param deps - Runner task dependencies.
 * @param params - Bound execution data for this task.
 * @returns Fully populated worker configuration.
 */
function buildFileWorkerConfig(deps: RunnerTaskDeps, params: FileRunnerTaskParams): WorkflowWorkerConfig {
  return {
    source: { kind: 'path', path: params.filePath },
    executionId: params.executionId,
    workflowId: params.workflowId,
    triggerPayload: params.sanitizedTriggerPayload,
    triggerMode: params.triggerMode,
    inputs: params.boundInputs,
    config: params.boundConfig,
    ...(params.artifactRef !== undefined ? { artifactRef: params.artifactRef } : {}),
    scope: params.scope,
    busUrl: deps.config.busUrl,
    busAuth: deps.config.busAuth,
    env: deps.config.platformDefaults.env ?? {},
    coordinatorSessionId: params.coordinatorSessionId,
    cancelSubject: `workflow.${params.executionId}.cancel`,
    materializationSpec: params.materializationSpec,
  };
}

/**
 * Build the async task for a file-based workflow execution.
 *
 * Delegates to the configured {@link IWorkflowRunner} with a `path`-sourced
 * {@link WorkflowWorkerConfig}. The runner is responsible for loading the file
 * and managing the full execution lifecycle. If the runner returns a terminal
 * result without having already finalized durable state, the host executor
 * persists that result as a fallback.
 * @param call - Call context of the message that triggered this execution.
 * @param deps - Runner task dependencies.
 * @param params - Identifiers and pre-computed execution data.
 * @returns Settled Promise tracked in `executionTasks`.
 */
export function buildFileExecutionTask(
  call: CallContext,
  deps: RunnerTaskDeps,
  params: FileRunnerTaskParams,
): Promise<void> {
  const { executionId } = params;
  const { workflowRunner, workflowAbortControllers, activeExecutions } = deps;
  const ownedExecution = activeExecutions.get(executionId);

  const controller = new AbortController();
  workflowAbortControllers.set(executionId, controller);

  const workerConfig = buildFileWorkerConfig(deps, params);
  const runOptions = ownerAdmissionOptions(call, deps, executionId, controller.signal);

  return Promise.resolve()
    .then(() => workflowRunner.run(call, workerConfig, controller.signal, undefined, runOptions))
    .then(async (completion) => {
      await handleRunnerCompletion(call, deps, completion, workerConfig, ownedExecution);
    })
    .catch(async (error: unknown) => {
      if (activeExecutions.get(executionId) !== ownedExecution) {
        console.error(`[WorkflowExecutor] Superseded file runner task failed for ${executionId}:`, error);
        return;
      }
      if (controller.signal.aborted) {
        await cancelRunningExecutionAfterRunnerAbort(call, deps, executionId, controller.signal).catch(
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
        await completeExecutionWithFailure(
          call,
          deps.buildFinalizerDeps(),
          active.execution,
          executionId,
          message,
        ).catch((persistError: unknown) => {
          console.error(
            `[WorkflowExecutor] Failed to persist file runner boot failure for ${executionId}:`,
            persistError,
          );
        });
      }
    })
    .finally(() => releaseRunnerTask(deps, executionId, ownedExecution, controller));
}

/**
 * Build the worker config for a storage-backed workflow runner task.
 * @param deps - Runner task dependencies.
 * @param params - Bound execution data for this task.
 * @returns Fully populated worker configuration.
 */
function buildDefinitionWorkerConfig(deps: RunnerTaskDeps, params: DefinitionRunnerTaskParams): WorkflowWorkerConfig {
  const { config } = deps;
  const serializedDefinition =
    params.definitionSnapshot ?? (params.source.kind === 'definition' ? params.workflow : undefined);
  return {
    source: params.source,
    ...(serializedDefinition !== undefined ? { definition: serializedDefinition } : {}),
    executionId: params.executionId,
    workflowId: params.workflowId,
    triggerPayload: params.sanitizedTriggerPayload,
    inputs: params.boundInputs,
    config: params.boundConfig,
    ...(params.artifactRef !== undefined ? { artifactRef: params.artifactRef } : {}),
    scope: params.scope,
    busUrl: config.busUrl,
    busAuth: config.busAuth,
    env: config.platformDefaults.env ?? {},
    coordinatorSessionId: params.coordinatorSessionId,
    cancelSubject: `workflow.${params.executionId}.cancel`,
    ...(params.terminalAuthority !== undefined && { terminalAuthority: params.terminalAuthority }),
    ...(params.materializationSpec !== undefined ? { materializationSpec: params.materializationSpec } : {}),
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
 * @param call - Call context of the message that triggered this execution.
 * @param deps - Runner task dependencies.
 * @param params - Identifiers, pre-computed execution data, and the workflow definition.
 * @returns Settled Promise tracked in `executionTasks`.
 */
export function buildExecutionTask(
  call: CallContext,
  deps: RunnerTaskDeps,
  params: DefinitionRunnerTaskParams,
): Promise<void> {
  const { executionId } = params;
  const { workflowRunner, workflowAbortControllers, activeExecutions } = deps;
  const ownedExecution = activeExecutions.get(executionId);

  const controller = new AbortController();
  workflowAbortControllers.set(executionId, controller);

  const workerConfig = buildDefinitionWorkerConfig(deps, params);
  const runOptions = ownerAdmissionOptions(call, deps, executionId, controller.signal);

  return Promise.resolve()
    .then(() => workflowRunner.run(call, workerConfig, controller.signal, undefined, runOptions))
    .then(async (completion) => {
      await handleRunnerCompletion(call, deps, completion, workerConfig, ownedExecution);
    })
    .catch(async (error: unknown) => {
      if (activeExecutions.get(executionId) !== ownedExecution) {
        console.error(`[WorkflowExecutor] Superseded runner task failed for ${executionId}:`, error);
        return;
      }
      if (controller.signal.aborted) {
        await cancelRunningExecutionAfterRunnerAbort(call, deps, executionId, controller.signal).catch(
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
        await completeExecutionWithFailure(
          call,
          deps.buildFinalizerDeps(),
          active.execution,
          executionId,
          message,
        ).catch((persistError: unknown) => {
          console.error(`[WorkflowExecutor] Failed to persist runner boot failure for ${executionId}:`, persistError);
        });
      }
    })
    .finally(() => releaseRunnerTask(deps, executionId, ownedExecution, controller));
}

/** Stable refusal code a host runner receives when durable state disallows admission. */
export type WorkflowRunAdmissionErrorCode = 'run-not-admissible';

/** Durable workflow state refused admission to new runner work. */
class WorkflowRunAdmissionError extends MakaioError {
  /** Stable refusal code exposed to the workflow runner. */
  public readonly code: WorkflowRunAdmissionErrorCode = 'run-not-admissible';

  /** @param executionId - Run whose durable state disallows admission. */
  public constructor(executionId: string) {
    super(`Execution '${executionId}' no longer permits runner admission`);
  }
}

/**
 * Bind runner admission to the current single-owner executor's lifecycle queue.
 * The durable status check prevents admission from stale local state.
 * This is owner admission, not a distributed lock between arbitrary executors.
 * @param call - Call context of the message that triggered the execution; forwarded by the status read.
 * @param deps - Current owner's shared lifecycle dependencies.
 * @param executionId - Run whose new work requires admission.
 * @param signal - Local cancellation, checked after acquiring admission.
 * @returns Local-only runner controls, never serialized onto the bus.
 */
function ownerAdmissionOptions(
  call: CallContext,
  deps: RunnerTaskDeps,
  executionId: string,
  signal: AbortSignal,
): WorkflowRunnerRunOptions {
  return {
    withRunAdmission: (create) => {
      const finalizerDeps = deps.buildFinalizerDeps();
      return withExecutionDurableTransition(finalizerDeps, executionId, async () => {
        signal.throwIfAborted();
        const { execution } = await finalizerDeps.bus.request(call, WorkflowStorageSubjects.getExecution, {
          executionId,
        });
        signal.throwIfAborted();
        if (execution?.status !== 'running') throw new WorkflowRunAdmissionError(executionId);
        return create();
      });
    },
  };
}
