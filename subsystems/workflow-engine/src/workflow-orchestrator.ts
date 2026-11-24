/* eslint max-lines: ["error", { "max": 445, "skipBlankLines": true, "skipComments": true }], max-lines-per-function: ["error", { "max": 100, "skipBlankLines": true, "skipComments": true }] */
import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/core';
import {
  WORKFLOW_CANCELLED_REASON,
  CodeStepHandler,
  LoopCheckHandler,
  WorkflowZodSchemas,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowRunContext,
  WorkflowRunContextSchema,
  WorkflowRunResult,
  WorkflowWorkerConfig,
} from '@makaio/contracts';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import { DEFAULT_EXECUTOR_CONFIG, type ActiveExecution, type ActiveRunnerStep } from './types.js';
import { WorkflowSubjects } from './namespace.js';
import { cancelExecution } from './workflow-execution-finalizer.js';
import { resolveEphemeralPlatformFields, RuntimeContext } from './runtime/runtime-context.js';
import { executeSequence } from './runtime/primitive-runtime.js';
import { resolveWorkflowArtifactBinding } from './artifact-context/artifact-binding.js';
import { assertLoopCheckHandlersPresent } from './runtime/loop-check-handlers.js';
import { persistLoadedExecutionStart } from './workflow-execution-start.js';
import { persistAuthorityLoadedState } from './authority-state-bootstrap.js';
import { buildWorkflowRunResult, type RuntimeSequenceResult } from './workflow-run-result.js';

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

/**
 * The resolved workflow module produced by a workflow file loader.
 *
 * Contains the serializable workflow definition and the runtime handler map
 * that the worker executor uses to dispatch code step nodes.
 */
export interface LoadedWorkflow {
  /** Serializable workflow definition (safe to persist or display in the UI). */
  readonly definition: WorkflowDefinition;
  /** Optional Zod schemas retained from file-loaded workflow builders. */
  readonly zodSchemas?: WorkflowZodSchemas;
  /**
   * Runtime code step handler functions keyed by node ID.
   * Used by the orchestrator to dispatch `codeStep`-type nodes.
   */
  readonly runtimeHandlers: ReadonlyMap<string, CodeStepHandler>;
  /** Loop check handler functions keyed by handler name. */
  readonly runtimeLoopChecks?: ReadonlyMap<string, LoopCheckHandler>;
}

/**
 * Input parameters for {@link runWorkflowOrchestrator}.
 */
interface WorkflowOrchestratorParams {
  /** Call context of the run; set by the run entry and forwarded by every send of the run. */
  readonly call: CallContext;
  /** Parsed and validated worker configuration. */
  readonly config: WorkflowWorkerConfig;
  /** Loaded workflow with definition and runtime handler map. */
  readonly loaded: LoadedWorkflow;
  /** Worker-local bus instance for emitting and subscribing to events. */
  readonly bus: IMakaioBus;
  /** Cancellation signal for cooperative abort. */
  readonly signal: AbortSignal;
  /** Machine-local workspace root supplied by the trusted execution entry point. */
  readonly workspaceRoot?: string;
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

/**
 * Persist the initial execution row and emit the terminal lifecycle event.
 *
 * Used for the fast-path cases (pre-scheduler abort, zero-node workflow)
 * so an immediately terminal execution still appears in storage.
 * @param call - Call context of the run.
 * @param bus - Worker-local bus.
 * @param config - Worker configuration for execution identifiers.
 * @param status - Terminal status to write.
 * @param reason - Optional cancellation reason.
 * @returns Terminal workflow run result.
 */
async function persistPreRuntimeTerminalExecution(
  call: CallContext,
  bus: IMakaioBus,
  config: WorkflowWorkerConfig,
  status: 'completed' | 'cancelled',
  reason?: string,
): Promise<WorkflowRunResult> {
  const execution = await buildPreRuntimeTerminalExecution(call, bus, config, status);

  await bus.request(call, WorkflowStorageSubjects.setExecution, { execution });

  if (status === 'completed') {
    await bus.emit(call, WorkflowSubjects.execution.completed, {
      executionId: config.executionId,
      workflowId: config.workflowId,
      totalDuration: 0,
      completedAt: execution.completedAt,
    });
  } else {
    await bus.emit(call, WorkflowSubjects.execution.cancelled, {
      executionId: config.executionId,
      workflowId: config.workflowId,
      reason,
      completedAt: execution.completedAt,
    });
  }

  if (status === 'cancelled') {
    return {
      executionId: config.executionId,
      workflowId: config.workflowId,
      status: 'cancelled',
      ...(reason !== undefined ? { reason } : {}),
    };
  }
  return { executionId: config.executionId, workflowId: config.workflowId, status: 'completed' };
}

// ─────────────────────────────────────────────────────────────
// Signal cancellation binding
// ─────────────────────────────────────────────────────────────

interface SignalCancellationBindingParams {
  readonly call: CallContext;
  readonly signal: AbortSignal;
  readonly executionId: string;
  readonly bus: IMakaioBus;
  readonly activeExecutions: Map<string, ActiveExecution>;
  readonly shellAbortControllers: Map<string, AbortController>;
  readonly activeRunnerSteps: Map<string, ActiveRunnerStep>;
  readonly durableLifecycleTransitions: Map<string, Promise<void>>;
  readonly lifecyclePublications: Map<string, Promise<void>>;
  readonly publishingLifecycleExecutions: Set<string>;
}

/**
 * Bind the worker-level cancellation signal to the finalizer.
 *
 * When `signal` fires, triggers `cancelExecution` to persist the cancelled
 * status and emit `execution.cancelled`.
 * @param params - Runtime state needed to terminalize the active execution.
 * @returns Async cleanup that removes the listener and reports whether signal cancellation finalized the execution.
 */
function bindSignalCancellation(params: SignalCancellationBindingParams): () => Promise<boolean> {
  let cancellationTask: Promise<boolean> | undefined;

  const cancelFromSignal = (): void => {
    cancellationTask = cancelExecution(
      params.call,
      {
        bus: params.bus,
        activeExecutions: params.activeExecutions,
        shellAbortControllers: params.shellAbortControllers,
        activeRunnerSteps: params.activeRunnerSteps,
        durableLifecycleTransitions: params.durableLifecycleTransitions,
        lifecyclePublications: params.lifecyclePublications,
        publishingLifecycleExecutions: params.publishingLifecycleExecutions,
        cancelTimeoutMs: DEFAULT_EXECUTOR_CONFIG.cancelTimeoutMs,
      },
      params.executionId,
      WORKFLOW_CANCELLED_REASON,
    ).catch((error: unknown) => {
      console.error(`[WorkflowOrchestrator] Failed to persist cancellation for ${params.executionId}:`, error);
      return false;
    });
  };

  params.signal.addEventListener('abort', cancelFromSignal, { once: true });
  if (params.signal.aborted) {
    cancelFromSignal();
  }

  return async (): Promise<boolean> => {
    params.signal.removeEventListener('abort', cancelFromSignal);
    return cancellationTask ?? false;
  };
}

// ─────────────────────────────────────────────────────────────
// Internal runtime helpers
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the start timestamp recorded before the worker starts.
 * @param call - Call context of the run.
 * @param bus - Worker-local bus that may expose workflow storage.
 * @param executionId - Execution identifier to inspect.
 * @returns Persisted start timestamp, or `undefined` when no row/handler exists.
 */
async function loadPersistedExecutionStartedAt(
  call: CallContext,
  bus: IMakaioBus,
  executionId: string,
): Promise<number | undefined> {
  const result = await bus.requestOptional(call, WorkflowStorageSubjects.getExecution, { executionId });
  return result.handled ? (result.data.execution?.startedAt ?? undefined) : undefined;
}

/**
 * Build the live execution row for worker startup while preserving the recorded start timestamp.
 * @param call - Call context of the run.
 * @param bus - Worker-local bus that may expose workflow storage.
 * @param config - Worker configuration for execution identifiers and inputs.
 * @returns Running execution row ready for persistence.
 */
async function buildRunningExecution(
  call: CallContext,
  bus: IMakaioBus,
  config: WorkflowWorkerConfig,
): Promise<WorkflowExecution> {
  return {
    id: config.executionId,
    workflowId: config.workflowId,
    coordinatorSessionId: config.coordinatorSessionId,
    status: 'running',
    inputs: config.inputs,
    config: config.config ?? {},
    startedAt: (await loadPersistedExecutionStartedAt(call, bus, config.executionId)) ?? Date.now(),
    triggerPayload: config.triggerPayload,
    ...(config.artifactRef !== undefined ? { artifactRef: config.artifactRef } : {}),
    scope: config.scope,
  };
}

/**
 * Build an immediate terminal execution row while preserving the recorded start timestamp.
 * @param call - Call context of the run.
 * @param bus - Worker-local bus that may expose workflow storage.
 * @param config - Worker configuration for execution identifiers and inputs.
 * @param status - Terminal status to persist.
 * @returns Terminal execution row ready for persistence.
 */
async function buildPreRuntimeTerminalExecution(
  call: CallContext,
  bus: IMakaioBus,
  config: WorkflowWorkerConfig,
  status: 'completed' | 'cancelled',
): Promise<WorkflowExecution> {
  const completedAt = Date.now();
  return {
    id: config.executionId,
    workflowId: config.workflowId,
    coordinatorSessionId: config.coordinatorSessionId,
    status,
    inputs: config.inputs,
    config: config.config ?? {},
    startedAt: (await loadPersistedExecutionStartedAt(call, bus, config.executionId)) ?? completedAt,
    completedAt,
    triggerPayload: config.triggerPayload,
    ...(config.artifactRef !== undefined ? { artifactRef: config.artifactRef } : {}),
    scope: config.scope,
  };
}

/**
 * Run the primitive runtime sequence and return the terminal status.
 *
 * Isolates the RuntimeContext construction, sequence execution, and outcome
 * mapping so {@link runWorkflowOrchestrator} can delegate the runtime body
 * without exceeding the per-function line limit.
 * @param call - Call context of the run.
 * @param config - Worker configuration carrying execution identifiers.
 * @param definition - Workflow definition to execute.
 * @param liveExecution - The live execution record.
 * @param runContext - Durable run-context snapshot for this execution.
 * @param runtimeHandlers - Code step handler map for dispatch.
 * @param runtimeLoopChecks - Loop check handler map for convergence checks.
 * @param bus - Worker-local bus.
 * @param signal - Cancellation signal.
 * @param workspaceRoot - Machine-local workspace root, when supplied by the entry point.
 * @param zodSchemas - Optional file-loaded workflow schemas for artifact validation.
 * @returns Terminal status and optional error message.
 */
async function runRuntimeSequence(
  call: CallContext,
  config: WorkflowWorkerConfig,
  definition: WorkflowDefinition,
  liveExecution: WorkflowExecution,
  runContext: WorkflowRunContext,
  runtimeHandlers: Map<string, CodeStepHandler>,
  runtimeLoopChecks: ReadonlyMap<string, LoopCheckHandler>,
  bus: IMakaioBus,
  signal: AbortSignal,
  workspaceRoot: string | undefined,
  zodSchemas?: WorkflowZodSchemas,
): Promise<RuntimeSequenceResult> {
  const artifactBinding = await resolveWorkflowArtifactBinding({
    call,
    definition,
    execution: liveExecution,
    runContext,
    zodSchema: zodSchemas?.artifact,
    bus,
  });
  const runtimeCtx = new RuntimeContext(
    config.executionId,
    config.workflowId,
    definition,
    liveExecution,
    runtimeHandlers,
    bus,
    signal,
    undefined,
    artifactBinding,
    {
      context: resolveEphemeralPlatformFields(workspaceRoot),
      env: config.env,
    },
    { runtimeLoopChecks, stepTimeoutMs: config.stepTimeoutMs },
  );
  const expressionCtx = runtimeCtx.buildExpressionContext();
  const outcome = await executeSequence(call, definition.root, runtimeCtx, expressionCtx);

  if (outcome.status === 'failed') {
    return { status: 'failed', error: outcome.error };
  }
  if (outcome.status === 'cancelled' || signal.aborted) {
    return { status: 'cancelled', reason: WORKFLOW_CANCELLED_REASON };
  }
  return { status: 'completed', artifact: artifactBinding?.current };
}

/**
 * Build the active-execution run-context snapshot from worker configuration.
 * @param config - Worker configuration passed to the isolated orchestrator.
 * @param definition - Loaded definition snapshot for definition-sourced runs.
 * @returns Durable run-context shape used by shared finalizer state.
 */
function buildWorkerRunContext(config: WorkflowWorkerConfig, definition: WorkflowDefinition) {
  return WorkflowRunContextSchema.parse({
    executionId: config.executionId,
    workflowId: config.workflowId,
    source:
      config.source.kind === 'path'
        ? { kind: 'path', path: config.materializationSpec?.sourcePath ?? '' }
        : config.source,
    definitionSnapshot: config.source.kind === 'definition' ? (config.definition ?? definition) : definition,
    workerManifest: { contributionRefs: [] },
    inputs: config.inputs,
    config: config.config ?? {},
    scope: config.scope,
    triggerPayload: config.triggerPayload,
    ...(config.artifactRef !== undefined ? { artifactRef: config.artifactRef } : {}),
    coordinatorSessionId: config.coordinatorSessionId,
    cancelSubject: config.cancelSubject,
    env: config.env,
    createdAt: Date.now(),
    ...(config.terminalAuthority !== undefined ? { terminalAuthority: config.terminalAuthority } : {}),
    ...(config.materializationSpec !== undefined ? { materializationSpec: config.materializationSpec } : {}),
  });
}

/**
 * Emit the terminal lifecycle event for a completed execution.
 * @param call - Call context of the run.
 * @param bus - Worker-local bus.
 * @param config - Worker configuration carrying execution identifiers.
 * @param status - Terminal status.
 * @param liveExecution - The settled execution record (startedAt used for duration).
 * @param completedAt - Unix timestamp when the execution ended.
 * @param error - Error message for failed executions.
 */
async function emitTerminalExecutionEvent(
  call: CallContext,
  bus: IMakaioBus,
  config: WorkflowWorkerConfig,
  status: 'completed' | 'failed' | 'cancelled',
  liveExecution: WorkflowExecution,
  completedAt: number,
  error?: string,
): Promise<void> {
  if (status === 'completed') {
    await bus.emit(call, WorkflowSubjects.execution.completed, {
      executionId: config.executionId,
      workflowId: config.workflowId,
      totalDuration: completedAt - liveExecution.startedAt,
      completedAt,
    });
  } else if (status === 'cancelled') {
    await bus.emit(call, WorkflowSubjects.execution.cancelled, {
      executionId: config.executionId,
      workflowId: config.workflowId,
      reason: WORKFLOW_CANCELLED_REASON,
      completedAt,
    });
  } else {
    await bus.emit(call, WorkflowSubjects.execution.failed, {
      executionId: config.executionId,
      workflowId: config.workflowId,
      error: error ?? 'Workflow execution failed',
      completedAt,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Orchestrate a full workflow execution inside an isolated worker.
 *
 * Builds an {@link ActiveExecution} from the worker config, persists the
 * initial execution state, and delegates all scheduling to the
 * primitive runtime ({@link executeSequence}), which handles:
 * - Sequential node execution with `when`/`skip` condition evaluation
 * - Parallel branch execution via `parallel` nodes
 * - Iterate/iterate-chain for collection processing
 * - Loop nodes with convergence checks
 * - Code step nodes dispatched via `runtimeHandlers`
 *
 * ### Cancellation
 * When `signal` is already aborted before execution begins, returns a
 * `cancelled` result immediately. In-flight nodes are cancelled cooperatively
 * via the abort signal propagated through the `RuntimeContext`.
 *
 * ### Persistence contract
 * The caller MUST ensure a {@link WorkflowStorageSubjects} handler is registered
 * on the bus before calling this function. When `setExecutionStart` is
 * available, the orchestrator checkpoints the loaded run context before
 * scheduling nodes; the runtime writes frame state on each transition.
 * @param params - Orchestrator parameters including call, config, loaded workflow, bus, and signal.
 * @returns Workflow run result with status `completed`, `failed`, or `cancelled`.
 */
export async function runWorkflowOrchestrator(params: WorkflowOrchestratorParams): Promise<WorkflowRunResult> {
  const { call, config, loaded, bus, signal } = params;
  const { definition } = loaded;

  if (signal.aborted) {
    if (config.terminalAuthority === 'authority') {
      return {
        executionId: config.executionId,
        workflowId: config.workflowId,
        status: 'cancelled',
        reason: WORKFLOW_CANCELLED_REASON,
      };
    }
    return persistPreRuntimeTerminalExecution(call, bus, config, 'cancelled', WORKFLOW_CANCELLED_REASON);
  }

  const liveExecution = await buildRunningExecution(call, bus, config);
  const runContext = buildWorkerRunContext(config, definition);
  if (config.terminalAuthority !== 'authority')
    await persistLoadedExecutionStart(call, bus, liveExecution, runContext, definition);
  else await persistAuthorityLoadedState(call, bus, runContext, definition);

  const runtimeHandlers = new Map<string, CodeStepHandler>(loaded.runtimeHandlers);
  const runtimeLoopChecks = loaded.runtimeLoopChecks ?? new Map<string, LoopCheckHandler>();
  const activeExecutions = new Map<string, ActiveExecution>();
  const shellAbortControllers = new Map<string, AbortController>();
  const activeRunnerSteps = new Map<string, ActiveRunnerStep>();
  const durableLifecycleTransitions = new Map<string, Promise<void>>();
  const lifecyclePublications = new Map<string, Promise<void>>();
  const publishingLifecycleExecutions = new Set<string>();

  activeExecutions.set(config.executionId, {
    execution: liveExecution,
    workflow: definition,
    runContext,
    runtimeHandlers,
    runtimeLoopChecks: new Map(runtimeLoopChecks),
  });

  const releaseSignalCancellation =
    config.terminalAuthority === 'authority'
      ? async (): Promise<boolean> => false
      : bindSignalCancellation({
          call,
          signal,
          executionId: config.executionId,
          bus,
          activeExecutions,
          shellAbortControllers,
          activeRunnerSteps,
          durableLifecycleTransitions,
          lifecyclePublications,
          publishingLifecycleExecutions,
        });

  let result: RuntimeSequenceResult = { status: 'completed' };

  let signalCancellationFinalized = false;

  try {
    if (definition.root.nodes.length > 0) {
      assertLoopCheckHandlersPresent(definition, runtimeLoopChecks);
      result = await runRuntimeSequence(
        call,
        config,
        definition,
        liveExecution,
        runContext,
        runtimeHandlers,
        runtimeLoopChecks,
        bus,
        signal,
        params.workspaceRoot,
        loaded.zodSchemas,
      );
    }
  } catch (error) {
    result = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  } finally {
    signalCancellationFinalized = await releaseSignalCancellation();
    activeExecutions.clear();
  }

  if (signalCancellationFinalized) {
    // Signal cancellation owns the terminal write and lifecycle event once
    // cancelExecution() transitions the active run to cancelled.
    return buildWorkflowRunResult(config, { status: 'cancelled', reason: WORKFLOW_CANCELLED_REASON });
  }

  if (signal.aborted || liveExecution.status === 'cancelled') {
    result = { status: 'cancelled', reason: WORKFLOW_CANCELLED_REASON };
  }

  if (config.terminalAuthority === 'authority') {
    return buildWorkflowRunResult(config, result);
  }

  const completedAt = Date.now();
  const terminalError = result.status === 'failed' ? result.error : undefined;
  liveExecution.status = result.status;
  liveExecution.completedAt = completedAt;
  liveExecution.error = terminalError;
  await bus.request(call, WorkflowStorageSubjects.setExecution, { execution: liveExecution });
  await emitTerminalExecutionEvent(call, bus, config, result.status, liveExecution, completedAt, terminalError);

  return buildWorkflowRunResult(config, result);
}
