/* eslint max-lines: ["error", { "max": 445, "skipBlankLines": true, "skipComments": true }], max-lines-per-function: ["error", { "max": 100, "skipBlankLines": true, "skipComments": true }] */
import * as os from 'node:os';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  WORKFLOW_CANCELLED_REASON,
  type ArtifactRevision,
  LoopGateHandler,
  StationHandler,
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
import { RuntimeContext } from './runtime/runtime-context.js';
import { executeSequence } from './runtime/primitive-runtime.js';
import { resolveWorkflowArtifactBinding } from './artifact-context/artifact-binding.js';
import { buildResumeFrameIndex } from './runtime/resume-frames.js';
import { assertLoopGateHandlersPresent } from './runtime/loop-gate-handlers.js';
import { persistLoadedExecutionStart } from './workflow-execution-start.js';
import { persistAuthorityLoadedState } from './authority-state-bootstrap.js';

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

/**
 * The resolved workflow module produced by a workflow file loader.
 *
 * Contains the serializable workflow definition and the runtime handler map
 * that the worker executor uses to dispatch station nodes.
 */
export interface LoadedWorkflow {
  /** Serializable workflow definition (safe to persist or display in the UI). */
  readonly definition: WorkflowDefinition;
  /** Optional Zod schemas retained from file-loaded workflow builders. */
  readonly zodSchemas?: WorkflowZodSchemas;
  /**
   * Runtime station handler functions keyed by node ID.
   * Used by the orchestrator to dispatch `station`-type nodes.
   */
  readonly runtimeHandlers: ReadonlyMap<string, StationHandler>;
  /** Loop gate handler functions keyed by handler name. */
  readonly runtimeLoopGates?: ReadonlyMap<string, LoopGateHandler>;
}

/**
 * Input parameters for {@link runWorkflowOrchestrator}.
 */
interface WorkflowOrchestratorParams {
  /** Parsed and validated worker configuration. */
  readonly config: WorkflowWorkerConfig;
  /** Loaded workflow with definition and runtime handler map. */
  readonly loaded: LoadedWorkflow;
  /** Worker-local bus instance for emitting and subscribing to events. */
  readonly bus: IMakaioBus;
  /** Cancellation signal for cooperative abort. */
  readonly signal: AbortSignal;
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

/**
 * Persist the initial execution row and emit the terminal lifecycle event.
 *
 * Used for the fast-path cases (pre-scheduler abort, zero-node workflow)
 * so an immediately terminal execution still appears in storage.
 * @param bus - Worker-local bus.
 * @param config - Worker configuration for execution identifiers.
 * @param status - Terminal status to write.
 * @param reason - Optional cancellation reason.
 * @returns Terminal workflow run result.
 */
async function persistPreRuntimeTerminalExecution(
  bus: IMakaioBus,
  config: WorkflowWorkerConfig,
  status: 'completed' | 'cancelled',
  reason?: string,
): Promise<WorkflowRunResult> {
  const execution = await buildPreRuntimeTerminalExecution(bus, config, status);

  await bus.request(WorkflowStorageSubjects.setExecution, { execution });

  if (status === 'completed') {
    await bus.emit(WorkflowSubjects.execution.completed, {
      executionId: config.executionId,
      workflowId: config.workflowId,
      totalDuration: 0,
      completedAt: execution.completedAt,
    });
  } else {
    await bus.emit(WorkflowSubjects.execution.cancelled, {
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

/**
 * Convert the settled execution state into the worker runner result.
 * @param config - Worker configuration carrying stable execution identifiers.
 * @param result - Settled runtime sequence result.
 * @returns Serializable workflow runner result.
 */
function buildWorkflowRunResult(config: WorkflowWorkerConfig, result: RuntimeSequenceResult): WorkflowRunResult {
  if (result.status === 'completed') {
    return {
      executionId: config.executionId,
      workflowId: config.workflowId,
      status: 'completed',
      ...(result.artifact !== undefined ? { artifact: result.artifact } : {}),
    };
  }
  if (result.status === 'cancelled') {
    return {
      executionId: config.executionId,
      workflowId: config.workflowId,
      status: 'cancelled',
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    };
  }
  if (result.status === 'paused') {
    return {
      executionId: config.executionId,
      workflowId: config.workflowId,
      status: 'paused',
      pausedAtGateId: result.pausedAtGateId,
      pausedAtFrameId: result.pausedAtFrameId,
    };
  }
  return {
    executionId: config.executionId,
    workflowId: config.workflowId,
    status: 'failed',
    error: result.error,
  };
}

// ─────────────────────────────────────────────────────────────
// Signal cancellation binding
// ─────────────────────────────────────────────────────────────

interface SignalCancellationBindingParams {
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
 * Result type from {@link runRuntimeSequence}.
 *
 * Discriminated on `status` so callers can access gate identity fields without
 * runtime guards after narrowing to `'paused'`.
 */
type RuntimeSequenceResult =
  | { readonly status: 'completed'; readonly artifact?: ArtifactRevision }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'cancelled'; readonly reason?: string }
  | {
      readonly status: 'paused';
      /** Node ID of the gate at which execution was suspended. */
      readonly pausedAtGateId: string;
      /** Frame ID of the suspended gate instance. */
      readonly pausedAtFrameId: string;
    };

/**
 * Resolve the durable execution start timestamp when a worker is re-dispatched.
 * @param bus - Worker-local bus that may expose workflow storage.
 * @param executionId - Execution identifier to inspect.
 * @returns Persisted start timestamp, or `undefined` when no row/handler exists.
 */
async function loadPersistedExecutionStartedAt(bus: IMakaioBus, executionId: string): Promise<number | undefined> {
  const result = await bus.requestOptional(WorkflowStorageSubjects.getExecution, { executionId });
  return result.handled ? (result.data.execution?.startedAt ?? undefined) : undefined;
}

/**
 * Build the live execution row for worker startup while preserving durable
 * execution metadata across exit-based re-dispatches.
 * @param bus - Worker-local bus that may expose workflow storage.
 * @param config - Worker configuration for execution identifiers and inputs.
 * @returns Running execution row ready for persistence.
 */
async function buildRunningExecution(bus: IMakaioBus, config: WorkflowWorkerConfig): Promise<WorkflowExecution> {
  return {
    id: config.executionId,
    workflowId: config.workflowId,
    coordinatorSessionId: config.coordinatorSessionId,
    status: 'running',
    inputs: config.inputs,
    config: config.config ?? {},
    startedAt: (await loadPersistedExecutionStartedAt(bus, config.executionId)) ?? Date.now(),
    triggerPayload: config.triggerPayload,
    ...(config.artifactRef !== undefined ? { artifactRef: config.artifactRef } : {}),
    scope: config.scope,
  };
}

/**
 * Build an immediate terminal execution row while preserving the original start
 * timestamp when this worker is re-dispatched for a paused execution.
 * @param bus - Worker-local bus that may expose workflow storage.
 * @param config - Worker configuration for execution identifiers and inputs.
 * @param status - Terminal status to persist.
 * @returns Terminal execution row ready for persistence.
 */
async function buildPreRuntimeTerminalExecution(
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
    startedAt: (await loadPersistedExecutionStartedAt(bus, config.executionId)) ?? completedAt,
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
 *
 * For re-dispatched executions (identified by `suspensionStrategy` being an
 * exit-based value), persisted frames are loaded from storage and indexed into
 * a {@link ResumeFrameIndex} so the sequence executor can skip already-completed
 * nodes and reuse waiting gate frames without re-opening them.
 * @param config - Worker configuration carrying execution identifiers.
 * @param definition - Workflow definition to execute.
 * @param liveExecution - The live execution record.
 * @param runContext - Durable run-context snapshot for this execution.
 * @param runtimeHandlers - Station handler map for dispatch.
 * @param runtimeLoopGates - Loop gate handler map for convergence checks.
 * @param bus - Worker-local bus.
 * @param signal - Cancellation signal.
 * @param zodSchemas - Optional file-loaded workflow schemas for artifact validation.
 * @returns Terminal status and optional error message.
 */
async function runRuntimeSequence(
  config: WorkflowWorkerConfig,
  definition: WorkflowDefinition,
  liveExecution: WorkflowExecution,
  runContext: WorkflowRunContext,
  runtimeHandlers: Map<string, StationHandler>,
  runtimeLoopGates: ReadonlyMap<string, LoopGateHandler>,
  bus: IMakaioBus,
  signal: AbortSignal,
  zodSchemas?: WorkflowZodSchemas,
): Promise<RuntimeSequenceResult> {
  // For exit-based strategies, load persisted frames from storage so the
  // sequence executor can skip completed nodes and reuse waiting gate frames.
  const resumeFrames =
    config.suspensionStrategy !== 'wait-in-process'
      ? await loadResumeFrames(config.executionId, bus, { required: true })
      : undefined;

  const artifactBinding = await resolveWorkflowArtifactBinding({
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
      context: {
        repoPath: process.cwd(),
        makaioHome: process.env['MAKAIO_HOME'] ?? `${os.homedir()}/.makaio`,
        os: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        arch: process.arch,
      },
      env: config.env,
    },
    { suspensionStrategy: config.suspensionStrategy, resumeFrames, runtimeLoopGates },
  );
  const expressionCtx = runtimeCtx.buildExpressionContext();
  const outcome = await executeSequence(definition.root, runtimeCtx, expressionCtx);

  if (outcome.status === 'failed') {
    return { status: 'failed', error: outcome.error };
  }
  if (outcome.status === 'paused') {
    return {
      status: 'paused',
      pausedAtGateId: outcome.pausedAtGateId,
      pausedAtFrameId: outcome.pausedAtFrameId,
    };
  }
  if (outcome.status === 'cancelled' || signal.aborted) {
    return { status: 'cancelled', reason: WORKFLOW_CANCELLED_REASON };
  }
  return { status: 'completed', artifact: artifactBinding?.current };
}

/**
 * Load persisted execution frames from storage and build a resume frame index.
 *
 * Returns `undefined` when no frames are found, which is the normal first-run
 * case for exit-based workers. When frame storage is required, missing handlers
 * or storage errors are surfaced so a paused-run resume cannot silently restart
 * as a fresh execution and duplicate side effects.
 * @param executionId - Execution identifier to load frames for.
 * @param bus - Worker-local bus.
 * @param options - Resume-frame loading behavior.
 * @returns Populated resume frame index, or `undefined` when no frames exist.
 */
async function loadResumeFrames(
  executionId: string,
  bus: IMakaioBus,
  options: { readonly required?: boolean } = {},
): Promise<ReturnType<typeof buildResumeFrameIndex>> {
  try {
    const result = await bus.requestOptional(WorkflowStorageSubjects.listFrames, { executionId });
    if (!result.handled) {
      if (options.required === true) {
        throw new Error(`Frame storage handler is required to resume execution '${executionId}'.`);
      }
      return undefined;
    }
    if (result.data.frames.length === 0) {
      return undefined;
    }
    return buildResumeFrameIndex(result.data.frames);
  } catch (error) {
    if (options.required === true) {
      throw error;
    }
    return undefined;
  }
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
    suspensionStrategy: config.suspensionStrategy,
    ...(config.terminalAuthority !== undefined ? { terminalAuthority: config.terminalAuthority } : {}),
    ...(config.materializationSpec !== undefined ? { materializationSpec: config.materializationSpec } : {}),
  });
}

/**
 * Persist a paused execution and emit `execution.paused`.
 *
 * Paused is not a terminal status: `completedAt` is not set and the distinct
 * `execution.paused` event (not `execution.completed`) notifies host runners.
 * @param bus - Worker-local bus.
 * @param config - Worker configuration carrying execution identifiers.
 * @param liveExecution - The live execution record (mutated to `paused` status).
 * @param pausedAtGateId - Node ID of the gate at which execution paused.
 * @param pausedAtFrameId - Frame ID of the suspended gate instance.
 */
async function persistPausedExecution(
  bus: IMakaioBus,
  config: WorkflowWorkerConfig,
  liveExecution: WorkflowExecution,
  pausedAtGateId: string,
  pausedAtFrameId: string,
): Promise<void> {
  liveExecution.status = 'paused';
  await bus.request(WorkflowStorageSubjects.setExecution, { execution: liveExecution });
  await bus.emit(WorkflowSubjects.execution.paused, {
    executionId: config.executionId,
    workflowId: config.workflowId,
    pausedAtGateId,
    pausedAtFrameId,
  });
}

/**
 * Emit the terminal lifecycle event for a completed execution.
 * @param bus - Worker-local bus.
 * @param config - Worker configuration carrying execution identifiers.
 * @param status - Terminal status.
 * @param liveExecution - The settled execution record (startedAt used for duration).
 * @param completedAt - Unix timestamp when the execution ended.
 * @param error - Error message for failed executions.
 */
async function emitTerminalExecutionEvent(
  bus: IMakaioBus,
  config: WorkflowWorkerConfig,
  status: 'completed' | 'failed' | 'cancelled',
  liveExecution: WorkflowExecution,
  completedAt: number,
  error?: string,
): Promise<void> {
  if (status === 'completed') {
    await bus.emit(WorkflowSubjects.execution.completed, {
      executionId: config.executionId,
      workflowId: config.workflowId,
      totalDuration: completedAt - liveExecution.startedAt,
      completedAt,
    });
  } else if (status === 'cancelled') {
    await bus.emit(WorkflowSubjects.execution.cancelled, {
      executionId: config.executionId,
      workflowId: config.workflowId,
      reason: WORKFLOW_CANCELLED_REASON,
      completedAt,
    });
  } else {
    await bus.emit(WorkflowSubjects.execution.failed, {
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
 * - Gate nodes with suspend/resume lifecycle
 * - Station nodes dispatched via `runtimeHandlers`
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
 * @param params - Orchestrator parameters including config, loaded workflow, bus, and signal.
 * @returns Workflow run result with status `completed`, `failed`, `cancelled`, or `paused`.
 */
export async function runWorkflowOrchestrator(params: WorkflowOrchestratorParams): Promise<WorkflowRunResult> {
  const { config, loaded, bus, signal } = params;
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
    return persistPreRuntimeTerminalExecution(bus, config, 'cancelled', WORKFLOW_CANCELLED_REASON);
  }

  const liveExecution = await buildRunningExecution(bus, config);
  const runContext = buildWorkerRunContext(config, definition);
  if (config.terminalAuthority !== 'authority')
    await persistLoadedExecutionStart(bus, liveExecution, runContext, definition);
  else await persistAuthorityLoadedState(bus, runContext, definition);

  const runtimeHandlers = new Map<string, StationHandler>(loaded.runtimeHandlers);
  const runtimeLoopGates = loaded.runtimeLoopGates ?? new Map<string, LoopGateHandler>();
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
    runtimeLoopGates: new Map(runtimeLoopGates),
  });

  const releaseSignalCancellation =
    config.terminalAuthority === 'authority'
      ? async (): Promise<boolean> => false
      : bindSignalCancellation({
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
      assertLoopGateHandlersPresent(definition, runtimeLoopGates);
      result = await runRuntimeSequence(
        config,
        definition,
        liveExecution,
        runContext,
        runtimeHandlers,
        runtimeLoopGates,
        bus,
        signal,
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

  // Paused executions are not terminal: they have no completedAt and emit a
  // distinct lifecycle event so host runners can checkpoint state and exit.
  if (result.status === 'paused') {
    if (config.terminalAuthority !== 'authority') {
      await persistPausedExecution(bus, config, liveExecution, result.pausedAtGateId, result.pausedAtFrameId);
    }
    return buildWorkflowRunResult(config, result);
  }

  if (config.terminalAuthority === 'authority') {
    return buildWorkflowRunResult(config, result);
  }

  const completedAt = Date.now();
  const terminalError = result.status === 'failed' ? result.error : undefined;
  liveExecution.status = result.status;
  liveExecution.completedAt = completedAt;
  liveExecution.error = terminalError;
  await bus.request(WorkflowStorageSubjects.setExecution, { execution: liveExecution });
  await emitTerminalExecutionEvent(bus, config, result.status, liveExecution, completedAt, terminalError);

  return buildWorkflowRunResult(config, result);
}
