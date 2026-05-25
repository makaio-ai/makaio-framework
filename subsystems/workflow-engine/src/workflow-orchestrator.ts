import type { IMakaioBus } from '@makaio/bus-core';
import type {
  AgentWorkflowStep,
  GateWorkflowStep,
  JsonValue,
  PreviousStepOutput,
  ShellWorkflowStep,
  StepContext,
  StepRunConfig,
  StepRunResult,
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowExecution,
  WorkflowRunResult,
  WorkflowStep,
  WorkflowStepFunction,
  WorkflowWorkerConfig,
} from '@makaio/contracts';
import { resolveTemplate, type WorkflowExpressionContext } from '@makaio/expression';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import type { ActiveExecution, ActiveRunnerStep } from './types.js';
import { DEFAULT_EXECUTOR_CONFIG } from './types.js';
import {
  executeFunctionStep,
  executeShellStepInWorker,
  executeAgentStepInWorker,
  executeGateStepInWorker,
} from './workflow-step-execution.js';
import { WorkflowScheduler } from './workflow-scheduler.js';
import { WorkflowGateCoordinator } from './workflow-gate-coordinator.js';
import { WorkflowSubjects } from './namespace.js';
import { cancelExecution } from './workflow-execution-finalizer.js';
import { buildWorkflowExpressionContextFromResolvedInputs } from './workflow-expression-context.js';

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

/**
 * The resolved workflow module produced by a workflow file loader.
 *
 * Contains the serializable workflow definition and the runtime step map
 * that the worker executor uses to dispatch function steps.
 */
export interface LoadedWorkflow {
  /** Serializable workflow definition (safe to persist or display in the UI). */
  readonly definition: WorkflowDefinitionInput;
  /**
   * Runtime step functions keyed by step ID.
   * Used by the orchestrator to dispatch `function`-type steps.
   */
  readonly runtimeSteps: ReadonlyMap<
    string,
    WorkflowStepFunction<unknown, Record<string, PreviousStepOutput<JsonValue>>, JsonValue>
  >;
}

/**
 * Input parameters for {@link runWorkflowOrchestrator}.
 */
interface WorkflowOrchestratorParams {
  /** Parsed and validated worker configuration. */
  readonly config: WorkflowWorkerConfig;
  /** Loaded workflow with definition and runtime step functions. */
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
 * Build the step context base from the worker config.
 *
 * The base is passed to function step executors so they can access workspace
 * metadata, trigger payloads, and resolved inputs.
 * @param config - Validated worker configuration for this execution.
 * @returns Step context base without `previousSteps`.
 */
function buildStepContextBase(
  config: WorkflowWorkerConfig,
): Omit<StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>>, 'previousSteps' | 'signal'> {
  return {
    repoPath: config.context.repoPath,
    makaioHome: config.context.makaioHome,
    os: config.context.os,
    arch: config.context.arch,
    worktree: config.context.worktree,
    inputs: config.inputs,
    env: config.env,
    executionId: config.executionId,
    workflowId: config.workflowId,
    trigger: config.triggerPayload,
  };
}

/**
 * Initialise the step state map for a fresh execution.
 *
 * For-each steps receive composite state; all other step types receive
 * executable state, both with `'pending'` status.
 * @param steps - Authored workflow steps from the definition.
 * @returns Step state map keyed by step ID.
 */
function buildInitialStepStates(steps: WorkflowStep[]): WorkflowExecution['steps'] {
  const result: WorkflowExecution['steps'] = {};
  for (const step of steps) {
    result[step.id] =
      step.type === 'for-each' ? { kind: 'composite', status: 'pending' } : { kind: 'executable', status: 'pending' };
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// Step dispatch callbacks
// ─────────────────────────────────────────────────────────────

/**
 * Build the `runStep` callback for `agent` and `shell` step types.
 *
 * Gate steps are handled by the scheduler's `runGateStep` callback, and
 * function steps by `runFunctionStep`. The `runStep` contract only covers
 * runner-serializable step types (`agent | shell`).
 * @param bus - Worker-local bus instance.
 * @param config - Worker configuration for coordinator session and defaults.
 * @param loaded - Loaded workflow providing the definition metadata.
 * @returns Callback satisfying the `WorkflowSchedulerDeps.runStep` signature.
 */
function buildRunStep(
  bus: IMakaioBus,
  config: WorkflowWorkerConfig,
  loaded: LoadedWorkflow,
): (runConfig: StepRunConfig, signal: AbortSignal) => Promise<StepRunResult> {
  return async (runConfig: StepRunConfig, signal: AbortSignal): Promise<StepRunResult> => {
    const expressionContext = buildWorkflowExpressionContextFromResolvedInputs(runConfig.resolvedInputs);

    if (runConfig.stepType === 'shell') {
      return executeShellStepInWorker({
        step: runConfig.stepDefinition as ShellWorkflowStep,
        workspaceRoot: config.context.repoPath,
        expressionContext,
        signal,
      });
    }

    if (runConfig.stepType === 'agent') {
      const agentStep = runConfig.stepDefinition as AgentWorkflowStep;
      return executeAgentStepInWorker({
        step: agentStep,
        bus,
        coordinatorSessionId: config.coordinatorSessionId,
        defaultExecutionTargetId: loaded.definition.defaultExecutionTargetId,
        signal,
        timeoutMs: DEFAULT_EXECUTOR_CONFIG.stepTimeoutMs,
        resolvedPrompt: resolveTemplate(agentStep.prompt, expressionContext),
      });
    }

    return {
      status: 'failed',
      error: `Unsupported step type in worker runStep: ${runConfig.stepType}`,
      telemetry: { duration: 0 },
    };
  };
}

/**
 * Build the `runFunctionStep` callback for the scheduler deps.
 *
 * Looks up the function step's runtime function from `loaded.runtimeSteps`,
 * builds a {@link StepContext} with `previousSteps` derived from completed
 * step results in the active execution, and invokes the function.
 * @param loaded - Loaded workflow providing the runtime step functions.
 * @param stepContextBase - Shared workspace context fields.
 * @param activeExecutions - Active execution registry for resolved step results.
 * @returns Callback satisfying the `WorkflowSchedulerDeps.runFunctionStep` signature.
 */
function buildRunFunctionStep(
  loaded: LoadedWorkflow,
  stepContextBase: Omit<
    StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>>,
    'previousSteps' | 'signal'
  >,
  activeExecutions: Map<string, ActiveExecution>,
): (
  executionId: string,
  stepId: string,
  resolvedInputs: WorkflowExpressionContext,
  signal: AbortSignal,
) => Promise<StepRunResult> {
  return async (
    executionId: string,
    stepId: string,
    _resolvedInputs: WorkflowExpressionContext,
    signal: AbortSignal,
  ): Promise<StepRunResult> => {
    if (signal.aborted) {
      return { status: 'failed', error: 'Cancelled', telemetry: { duration: 0 } };
    }

    const active = activeExecutions.get(executionId);
    const step = active?.stepMap.get(stepId);
    if (!step || step.type !== 'function') {
      return {
        status: 'failed',
        error: `Function step not found: ${stepId}`,
        telemetry: { duration: 0 },
      };
    }

    // Build previousSteps from terminal dependency states. Only steps declared
    // in `needs` are included so functions cannot access results from steps
    // they did not explicitly depend on.
    const previousSteps: Record<string, PreviousStepOutput<JsonValue>> = {};
    if (active) {
      for (const needsId of step.needs ?? []) {
        const state = active.execution.steps[needsId];
        if (state?.kind === 'executable' && state.status === 'completed') {
          previousSteps[needsId] = { output: state.result as JsonValue, status: 'completed' };
        } else if (state?.kind === 'executable' && state.status === 'skipped') {
          previousSteps[needsId] = { status: 'skipped' };
        }
      }
    }

    const context: StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>> = {
      ...stepContextBase,
      previousSteps,
      signal,
    };

    return executeFunctionStep({ loaded, stepId, context, signal });
  };
}

/**
 * Build the `runGateStep` callback for the scheduler deps.
 *
 * In the worker context, gate coordination is handled by the main-process
 * executor via the `gate.awaitApproval` bus RPC. This keeps all gate state
 * management (registering pending resolutions, emitting `gate.requested`,
 * awaiting `gate.respond`) on the main-process bus where the gate coordinator
 * lives. The transport forwards the resolved result back to the worker.
 *
 * The scheduler's `runGateStep` path manages step lifecycle (state
 * initialisation, persistence, `step.started`/`step.completed`/`step.failed`)
 * via `prepareRunnerManagedStep` and `applyStepRunResult`, matching the
 * shell and agent step lifecycle.
 * @param bus - Worker-local bus for the `gate.awaitApproval` RPC.
 * @param config - Worker configuration for execution and workflow IDs.
 * @param loaded - Loaded workflow providing the definition name.
 * @param activeExecutions - Active execution registry for step definition lookup.
 * @returns Callback satisfying the `WorkflowSchedulerDeps.runGateStep` signature.
 */
function buildRunGateStep(
  bus: IMakaioBus,
  config: WorkflowWorkerConfig,
  loaded: LoadedWorkflow,
  activeExecutions: Map<string, ActiveExecution>,
): (
  executionId: string,
  stepId: string,
  resolvedInputs: WorkflowExpressionContext,
  signal: AbortSignal,
) => Promise<StepRunResult> {
  return async (
    executionId: string,
    stepId: string,
    resolvedInputs: WorkflowExpressionContext,
    signal: AbortSignal,
  ): Promise<StepRunResult> => {
    const active = activeExecutions.get(executionId);
    const step = active?.stepMap.get(stepId);
    if (!step || step.type !== 'gate') {
      return {
        status: 'failed',
        error: `Gate step not found: ${stepId}`,
        telemetry: { duration: 0 },
      };
    }

    const gateStep = step as GateWorkflowStep;
    const resolvedPrompt = resolveTemplate(gateStep.prompt, resolvedInputs);
    const resolvedTitle = gateStep.title
      ? resolveTemplate(gateStep.title, resolvedInputs)
      : 'Workflow Approval Required';

    return executeGateStepInWorker({
      step: gateStep,
      bus,
      executionId: config.executionId,
      workflowId: config.workflowId,
      workflowName: loaded.definition.name,
      resolvedPrompt,
      resolvedTitle,
      signal,
    });
  };
}

interface SignalCancellationBindingParams {
  /** Worker execution cancellation signal. */
  readonly signal: AbortSignal;
  /** Execution ID to cancel when the signal aborts. */
  readonly executionId: string;
  /** Worker-local bus for persistence and lifecycle events. */
  readonly bus: IMakaioBus;
  /** Active execution registry owned by the worker orchestrator. */
  readonly activeExecutions: Map<string, ActiveExecution>;
  /** Inline shell/function/gate abort controllers keyed by execution and step ID. */
  readonly shellAbortControllers: Map<string, AbortController>;
  /** Active runner steps keyed by execution and step ID. */
  readonly activeRunnerSteps: Map<string, ActiveRunnerStep>;
  /** Gate coordinator used to release pending gate waits. */
  readonly gateCoordinator: WorkflowGateCoordinator;
}

/**
 * Bind the worker-level cancellation signal to the scheduler finalizer.
 * @param params - Runtime state needed to terminalize the active worker execution.
 * @returns Cleanup callback that removes the listener and awaits any in-flight cancellation.
 */
function bindSignalCancellation(params: SignalCancellationBindingParams): () => Promise<void> {
  let cancellationTask: Promise<boolean> | undefined;
  const cancelFromSignal = (): void => {
    cancellationTask = cancelExecution(
      {
        bus: params.bus,
        activeExecutions: params.activeExecutions,
        shellAbortControllers: params.shellAbortControllers,
        activeRunnerSteps: params.activeRunnerSteps,
        cancelTimeoutMs: DEFAULT_EXECUTOR_CONFIG.cancelTimeoutMs,
        gateCoordinator: params.gateCoordinator,
      },
      params.executionId,
      'Workflow cancelled',
    ).catch((error: unknown) => {
      console.error(`[WorkflowOrchestrator] Failed to persist cancellation for ${params.executionId}:`, error);
      return false;
    });
  };

  params.signal.addEventListener('abort', cancelFromSignal, { once: true });
  if (params.signal.aborted) {
    cancelFromSignal();
  }

  return async (): Promise<void> => {
    params.signal.removeEventListener('abort', cancelFromSignal);
    await cancellationTask;
  };
}

/**
 * Convert the settled execution state into the worker runner result.
 * @param config - Worker configuration carrying stable execution identifiers.
 * @param execution - Mutable execution record settled by the scheduler/finalizer.
 * @returns Terminal workflow runner result.
 */
function buildWorkflowRunResult(config: WorkflowWorkerConfig, execution: WorkflowExecution): WorkflowRunResult {
  if (execution.status === 'completed') {
    return { executionId: config.executionId, workflowId: config.workflowId, status: 'completed' };
  }

  if (execution.status === 'cancelled') {
    return { executionId: config.executionId, workflowId: config.workflowId, status: 'cancelled' };
  }

  return {
    executionId: config.executionId,
    workflowId: config.workflowId,
    status: 'failed',
    output: execution.error ?? 'Workflow execution failed',
  };
}

/**
 * Persist and emit a terminal execution state before the scheduler starts.
 * @param bus - Worker-local bus with workflow storage handlers.
 * @param config - Worker configuration for execution identifiers.
 * @param execution - Mutable execution record to terminalize.
 * @param status - Terminal status to persist.
 * @param reason - Optional cancellation reason.
 * @returns Terminal workflow run result.
 */
async function persistPreSchedulerTerminalExecution(
  bus: IMakaioBus,
  config: WorkflowWorkerConfig,
  execution: WorkflowExecution,
  status: 'completed' | 'cancelled',
  reason?: string,
): Promise<WorkflowRunResult> {
  execution.status = status;
  execution.completedAt = Date.now();

  if (status === 'cancelled') {
    for (const [stepId, stepState] of Object.entries(execution.steps)) {
      if (stepState.kind === 'composite') {
        execution.steps[stepId] = { ...stepState, status: 'cancelled' };
      } else {
        execution.steps[stepId] = {
          ...stepState,
          status: 'failed',
          error: reason ?? 'Workflow cancelled',
          completedAt: execution.completedAt,
        };
      }
    }
  }

  await bus.request(WorkflowStorageSubjects.setExecution, { execution });
  if (status === 'completed') {
    await bus.emit(WorkflowSubjects.execution.completed, {
      executionId: config.executionId,
      totalDuration: execution.completedAt - execution.startedAt,
    });
  } else {
    await bus.emit(WorkflowSubjects.execution.cancelled, { executionId: config.executionId, reason });
  }

  return { executionId: config.executionId, workflowId: config.workflowId, status };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Orchestrate a full workflow execution inside an isolated worker.
 *
 * Builds an {@link ActiveExecution} from the worker config, persists the
 * initial execution state, and delegates all scheduling to
 * {@link WorkflowScheduler}, which handles:
 * - DAG scheduling with for-each runtime expansion
 * - `if`-condition evaluation and step skipping
 * - Lifecycle event emission (`step.started`, `step.completed`, etc.)
 * - Persistent state writes via {@link WorkflowStorageSubjects}
 *
 * Step types are dispatched as follows:
 * - `function`: invokes the runtime step function directly via `runFunctionStep`
 * - `shell`: spawns an external process via {@link executeShellStepInWorker}
 * - `agent`: spawns a subagent via the bus and awaits completion
 * - `gate`: forwards to the main-process gate coordinator via `gate.awaitApproval`
 *   RPC; the main process registers the pending gate, emits `gate.requested`,
 *   and awaits the user's `gate.respond` response
 *
 * ### Cancellation
 * When `signal` is already aborted before execution begins, returns a
 * `cancelled` result immediately without touching any steps. In-flight steps
 * are cancelled cooperatively via the scheduler's abort handling.
 *
 * ### Persistence contract
 * The caller MUST ensure a {@link WorkflowStorageSubjects} handler is registered
 * on the bus before calling this function. The orchestrator writes the initial
 * execution record; the scheduler writes step state changes on each transition.
 * @param params - Orchestrator parameters including config, loaded workflow, bus, and signal.
 * @returns Terminal workflow run result with status `completed`, `failed`, or `cancelled`.
 */
export async function runWorkflowOrchestrator(params: WorkflowOrchestratorParams): Promise<WorkflowRunResult> {
  const { config, loaded, bus, signal } = params;

  const { definition } = loaded;

  // Construct a WorkflowDefinition from WorkflowDefinitionInput by supplying
  // the storage-managed timestamp fields. The scheduler only uses the structural
  // definition fields so the placeholder values do not affect behaviour.
  const workflow: WorkflowDefinition = { ...definition, createdAt: 0, updatedAt: 0 };

  // Build the initial execution state with all authored steps in `pending`.
  const execution: WorkflowExecution = {
    id: config.executionId,
    workflowId: config.workflowId,
    coordinatorSessionId: config.coordinatorSessionId,
    status: 'running',
    inputs: config.inputs,
    steps: buildInitialStepStates(definition.steps),
    startedAt: Date.now(),
    triggerPayload: config.triggerPayload,
    scope: config.scope,
  };

  // Fast path: abort before scheduling any steps, while still terminalizing the
  // execution row that the main process created before dispatching the worker.
  if (signal.aborted) {
    return persistPreSchedulerTerminalExecution(bus, config, execution, 'cancelled', 'Workflow cancelled');
  }

  // Zero-step workflows complete immediately, but still persist and emit the
  // terminal lifecycle so observers do not see a permanently running execution.
  if (definition.steps.length === 0) {
    return persistPreSchedulerTerminalExecution(bus, config, execution, 'completed');
  }

  // Persist the initial execution record so the main process can observe it.
  await bus.request(WorkflowStorageSubjects.setExecution, { execution });

  const stepMap = new Map<string, WorkflowStep>(definition.steps.map((step) => [step.id, step]));
  const activeExecutions = new Map<string, ActiveExecution>();
  const shellAbortControllers = new Map<string, AbortController>();
  const activeRunnerSteps = new Map<string, ActiveRunnerStep>();

  activeExecutions.set(config.executionId, {
    execution,
    workflow,
    stepMap,
    stepContext: new Map(),
  });

  // The worker gate coordinator is a no-op placeholder — gate steps are handled
  // by the `runGateStep` callback via the `gate.awaitApproval` bus RPC instead
  // of the local gate coordinator path.
  const gateCoordinator = new WorkflowGateCoordinator(bus);

  const stepContextBase = buildStepContextBase(config);
  const releaseSignalCancellation = bindSignalCancellation({
    signal,
    executionId: config.executionId,
    bus,
    activeExecutions,
    shellAbortControllers,
    activeRunnerSteps,
    gateCoordinator,
  });

  const scheduler = new WorkflowScheduler(
    {
      bus,
      activeExecutions,
      shellAbortControllers,
      activeRunnerSteps,
      gateCoordinator,
      runStep: buildRunStep(bus, config, loaded),
      runnerManagesLifecycle: false,
      runFunctionStep: buildRunFunctionStep(loaded, stepContextBase, activeExecutions),
      runGateStep: buildRunGateStep(bus, config, loaded, activeExecutions),
      forceKillStep: undefined,
      onAbortSubagent: undefined,
      config: {
        ...DEFAULT_EXECUTOR_CONFIG,
        stepCooldownMs: 0,
        busAuth: config.busAuth,
        platformDefaults: { cwd: config.context.repoPath },
      },
    },
    config.executionId,
  );

  try {
    await scheduler.run(definition.steps);
  } finally {
    await releaseSignalCancellation();
    gateCoordinator.dispose();
    activeExecutions.clear();
  }

  // Derive the terminal result from the settled execution state.
  // The scheduler removes the execution from activeExecutions on completion,
  // so we must read the local execution reference directly.
  return buildWorkflowRunResult(config, execution);
}
