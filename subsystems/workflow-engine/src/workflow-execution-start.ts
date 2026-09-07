/* eslint max-lines: ["error", { "max": 500, "skipBlankLines": true, "skipComments": true }], max-lines-per-function: ["error", { "max": 90, "skipBlankLines": true, "skipComments": true }] */
import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  type ExecutionLink,
  type IWorkflowRunner,
  type JsonValue,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowExecutionScope,
  type WorkflowRunContext,
  type WorkflowTriggerMode,
  type WorkflowWorkerSource,
  WorkflowError,
  WorkflowErrorCode,
} from '@makaio/contracts';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import { type ExecutorConfig, type ActiveExecution, type WorkflowMaterializationSpecResolver } from './types.js';
import { generateId } from './executor-helpers.js';
import { sanitizeTriggerPayload } from './trigger-payload-sanitizer.js';
import { type FinalizerDeps } from './workflow-execution-finalizer.js';
import { getValidatedInitialWorkflowState } from './workflow-state-validation.js';
// dag-utils import removed: step DAG replaced by primitive runtime frame model
import {
  bindWorkflowInputs,
  bindWorkflowConfig,
  buildFileExecutionTask,
  type RunnerTaskDeps,
} from './workflow-runner-tasks.js';
import { launchDefinitionExecutionTask, selectDefinitionExecutionDispatch } from './workflow-definition-dispatch.js';
import type { ExecutionAttemptAuthority } from './execution-attempt-authority.js';
import type { WorkflowAttemptOutcome } from './workflow-attempt-outcome.js';

/**
 * Dependencies injected into the execution start helpers.
 *
 * Bundles the executor state and callbacks needed by {@link startExecution} and
 * {@link startFileExecution} so those functions can be extracted from the
 * {@link WorkflowExecutor} class body without losing access to shared state.
 */
export interface StartExecutionDeps {
  /** Message bus for session and storage requests. */
  bus: IMakaioBus;
  /** Executor configuration. */
  config: ExecutorConfig;
  /** Live execution registry shared with the finalizer and scheduler. */
  activeExecutions: Map<string, ActiveExecution>;
  /** Settled execution task promises tracked for shutdown draining. */
  executionTasks: Map<string, Promise<void>>;
  /** Optional workflow-level runner for isolated execution. */
  workflowRunner: IWorkflowRunner | undefined;
  /**
   * Build a fully populated {@link WorkflowRunContext} for persistence.
   * @param params - Source-specific context fields.
   */
  buildRunContext(params: {
    executionId: string;
    workflowId: string;
    coordinatorSessionId: string;
    source: WorkflowRunContext['source'];
    definitionSnapshot?: WorkflowRunContext['definitionSnapshot'];
    inputs: WorkflowRunContext['inputs'];
    config: WorkflowRunContext['config'];
    scope: WorkflowRunContext['scope'];
    triggerPayload: WorkflowRunContext['triggerPayload'];
    triggerMode?: WorkflowRunContext['triggerMode'];
    artifactRef?: WorkflowRunContext['artifactRef'];
    suspensionStrategy?: WorkflowRunContext['suspensionStrategy'];
    terminalAuthority?: WorkflowRunContext['terminalAuthority'];
    materializationSpec?: WorkflowRunContext['materializationSpec'];
  }): WorkflowRunContext;
  /**
   * Build a {@link RunnerTaskDeps} bundle for the given workflow runner.
   * @param workflowRunner - Runner instance to wrap.
   */
  buildRunnerTaskDeps(workflowRunner: IWorkflowRunner): RunnerTaskDeps;
  /** Factory that produces a {@link FinalizerDeps} snapshot from executor state. */
  buildFinalizerDeps(): FinalizerDeps;
  /**
   * Resolve the workspace root for a parent session, falling back to config cwd.
   * @param parentSessionId - Optional parent session identifier.
   */
  resolveExecutionWorkspaceRoot(parentSessionId?: string): Promise<string>;
  /**
   * Run an in-process execution via the mutable DAG scheduler.
   * @param executionId - Target execution identifier.
   */
  runExecution(executionId: string): Promise<void>;
  /**
   * Execution attempt Authority for Worker dispatch runners.
   *
   * When present, the dispatch runner uses this Authority to create
   * attempts before dispatch and wait for committed outcomes. When absent,
   * Worker dispatch is unavailable.
   */
  executionAttemptAuthority?: ExecutionAttemptAuthority<WorkflowAttemptOutcome>;
  /** Host seams that resolve immutable workspace references for path starts. */
  materializationSpecResolvers: ReadonlySet<WorkflowMaterializationSpecResolver>;
}

/**
 * Persist a worker-loaded execution snapshot through atomic start storage.
 *
 * Worker-loaded executions require `setExecutionStart` so execution, run
 * context, and initial state are recorded atomically before runtime work starts.
 * @param bus - Message bus used for storage requests.
 * @param execution - Running execution row.
 * @param runContext - Worker-loaded run-context snapshot.
 * @param definition - Loaded workflow definition.
 */
export async function persistLoadedExecutionStart(
  bus: IMakaioBus,
  execution: WorkflowExecution,
  runContext: WorkflowRunContext,
  definition: WorkflowDefinition,
): Promise<void> {
  const initialState = getValidatedInitialWorkflowState(definition);
  await bus.request(WorkflowStorageSubjects.setExecutionStart, {
    execution,
    runContext,
    initialState,
  });
}

/**
 * Emit the execution-started lifecycle event without letting observer failures
 * prevent an already-persisted execution from running.
 * @param bus - Message bus
 * @param execution - Already-persisted execution whose launch is being announced.
 */
async function emitExecutionStarted(bus: IMakaioBus, execution: WorkflowExecution): Promise<void> {
  try {
    await bus.emit(WorkflowSubjects.execution.started, {
      executionId: execution.id,
      workflowId: execution.workflowId,
      coordinatorSessionId: execution.coordinatorSessionId,
      startedAt: execution.startedAt,
      ...(execution.artifactRef !== undefined ? { artifactRef: execution.artifactRef } : {}),
    });
  } catch (error) {
    console.error('[WorkflowExecutor] execution.started listener failed:', error);
  }
}

/**
 * Close a coordinator session created for an execution that failed before launch.
 * @param bus - Message bus
 * @param sessionId - Coordinator session ID
 */
async function closeCoordinatorSession(bus: IMakaioBus, sessionId: string): Promise<void> {
  await bus.request(SessionSubjects.close, { sessionId }).catch((error: unknown) => {
    console.error(`[WorkflowExecutor] Failed to close coordinator session "${sessionId}" after launch failure:`, error);
  });
}

/**
 * Build a {@link WorkflowExecution} record and seed the active-executions registry.
 * @param activeExecutions - Live execution registry.
 * @param executionId - Unique execution identifier.
 * @param workflow - Workflow definition being executed.
 * @param coordinatorSessionId - Coordinator session owning this execution.
 * @param boundInputs - Resolved input value.
 * @param boundConfig - Resolved workflow configuration values.
 * @param sanitizedTriggerPayload - Sanitized trigger payload (may be null).
 * @param resolvedScope - Resolved execution scope.
 * @param runContext - Durable run-context snapshot for this execution.
 * @returns The newly constructed execution record.
 */
function seedDefinitionExecution(
  activeExecutions: Map<string, ActiveExecution>,
  executionId: string,
  workflow: WorkflowDefinition,
  coordinatorSessionId: string,
  boundInputs: JsonValue,
  boundConfig: Record<string, unknown>,
  sanitizedTriggerPayload: Record<string, unknown> | undefined,
  resolvedScope: WorkflowExecutionScope,
  runContext: WorkflowRunContext,
): WorkflowExecution {
  const execution: WorkflowExecution = {
    id: executionId,
    workflowId: workflow.id,
    coordinatorSessionId,
    status: 'running',
    inputs: boundInputs,
    config: boundConfig,
    startedAt: Date.now(),
    triggerPayload: sanitizedTriggerPayload,
    ...(runContext.artifactRef !== undefined ? { artifactRef: runContext.artifactRef } : {}),
    scope: resolvedScope,
  };
  // Definition-backed executions have no in-process station handlers.
  // Handler-bearing executions (e.g. runFile) supply runtimeHandlers separately.
  activeExecutions.set(executionId, {
    execution,
    workflow,
    runContext,
    runtimeHandlers: new Map(),
    runtimeLoopGates: new Map(),
  });
  return execution;
}

/**
 * Persist the execution row and its run-context snapshot atomically.
 *
 * The storage layer owns the transaction because execution rows and run-context
 * snapshots are stored in separate tables but are created as one launch unit.
 * @param bus - Message bus used for storage requests.
 * @param execution - The new `WorkflowExecution` record.
 * @param runContext - The pre-built {@link WorkflowRunContext} snapshot.
 * @param initialState - Optional validated initial workflow state.
 * @param executionLinks - Optional links persisted in the same start transaction.
 */
async function persistExecutionStart(
  bus: IMakaioBus,
  execution: WorkflowExecution,
  runContext: WorkflowRunContext,
  initialState: JsonValue | undefined,
  executionLinks: readonly ExecutionLink[] | undefined,
): Promise<void> {
  await bus.request(WorkflowStorageSubjects.setExecutionStart, {
    execution,
    runContext,
    ...(initialState !== undefined ? { initialState } : {}),
    ...(executionLinks !== undefined && executionLinks.length > 0 ? { executionLinks: [...executionLinks] } : {}),
  });
}

/**
 * Resolve the worker source for a definition-backed execution.
 *
 * When the workflow definition declares an `executableSource`, that portable
 * source descriptor is used directly. Otherwise falls back to the default
 * `{ kind: 'definition', workflowId }` which loads the workflow by its
 * registered definition ID at runtime.
 * @param workflow - The loaded workflow definition.
 * @param workflowId - The workflow definition ID.
 * @returns The resolved source descriptor.
 */
function resolveDefinitionExecutionSource(workflow: WorkflowDefinition, workflowId: string): WorkflowWorkerSource {
  return workflow.executableSource ?? { kind: 'definition', workflowId };
}

/**
 * Determine whether a runner receives the compiled definition directly.
 * Path-backed current runs reload their materialized source; explicitly
 * snapshot-pinned reruns instead execute the persisted definition.
 * @param source - Execution source selected for the launch.
 * @param definitionSnapshot - Explicit snapshot requested by the caller.
 * @returns Whether the runner config should include `definition`.
 */
function shouldSendDefinitionToRunner(
  source: WorkflowWorkerSource,
  definitionSnapshot: WorkflowDefinition | undefined,
): boolean {
  return source.kind === 'definition' || definitionSnapshot !== undefined;
}

/**
 * Ensure source-backed executions can be dispatched by a runner before storage is mutated.
 * @param runner - Execution mechanism already selected for this launch.
 * @param source - Resolved execution source.
 * @param workflowId - Logical workflow ID for the pending execution.
 * @throws When a path/source execution would otherwise fall back to the in-process scheduler.
 */
function assertRunnerBackedSourceDispatchAvailable(
  runner: IWorkflowRunner | undefined,
  source: WorkflowWorkerSource,
  workflowId: string,
): void {
  if (source.kind === 'definition' || runner !== undefined) {
    return;
  }
  throw new WorkflowError(
    WorkflowErrorCode.NOT_EXECUTABLE,
    `Workflow source execution '${workflowId}' requires a workflow runner.`,
  );
}

/**
 * Resolve the immutable workspace reference required by a path-backed start.
 *
 * A caller-supplied spec is reserved for replaying an existing durable run
 * context. Fresh starts resolve through the host seam before storage mutates.
 * @param deps - Shared executor dependencies.
 * @param input - Start identity and process-local source information.
 * @param providedSpec - Existing durable spec supplied by a replay path.
 * @returns The resolved durable spec, or undefined for non-path sources.
 */
async function resolveMaterializationSpec(
  deps: StartExecutionDeps,
  input: {
    executionId: string;
    workflowId: string;
    source: WorkflowRunContext['source'];
    workspaceRoot: string;
  },
  providedSpec: WorkflowRunContext['materializationSpec'] | undefined,
): Promise<WorkflowRunContext['materializationSpec'] | undefined> {
  if (input.source.kind !== 'path') return undefined;
  if (providedSpec !== undefined) return providedSpec;
  for (const resolver of deps.materializationSpecResolvers) {
    const resolved = await resolver.resolve({
      executionId: input.executionId,
      workflowId: input.workflowId,
      sourcePath: input.source.path,
      workspaceRoot: input.workspaceRoot,
    });
    if (resolved !== undefined) return resolved;
  }
  throw new Error('[WorkflowExecutor] path-backed execution requires a resolved materializationSpec');
}

/** Durable source and immutable workspace reference selected for one start. */
interface ResolvedDurablePathSource {
  /** Portable source persisted into the run context. */
  readonly source: WorkflowRunContext['source'];
  /** Workspace reference persisted with a path-backed source. */
  readonly materializationSpec: WorkflowRunContext['materializationSpec'] | undefined;
}

/**
 * Resolve the durable source form for a fresh or replayed execution start.
 * @param deps - Shared executor dependencies.
 * @param input - Start identity and source information.
 * @param providedSpec - Existing durable spec supplied by a replay path.
 * @returns Portable source and immutable workspace reference.
 */
async function resolveDurablePathSource(
  deps: StartExecutionDeps,
  input: {
    executionId: string;
    workflowId: string;
    source: WorkflowRunContext['source'];
    workspaceRoot: string;
  },
  providedSpec: WorkflowRunContext['materializationSpec'] | undefined,
): Promise<ResolvedDurablePathSource> {
  const materializationSpec = await resolveMaterializationSpec(deps, input, providedSpec);
  return {
    source:
      input.source.kind === 'path' && materializationSpec !== undefined
        ? { kind: 'path', path: materializationSpec.sourcePath }
        : input.source,
    materializationSpec,
  };
}

/**
 * Register the execution task, fire-and-forget it, then await the started event.
 *
 * Shared by {@link startExecution} and {@link startFileExecution} to avoid
 * duplicating the final launch sequence.
 * @param executionTasks - Task registry keyed by execution ID.
 * @param executionId - Unique execution identifier.
 * @param executionTask - The settled Promise that drives the execution lifecycle.
 * @param startedEventTask - Pending emission of the `execution.started` event.
 * @returns The execution ID when the started event has been dispatched.
 */
async function dispatchAndAwait(
  executionTasks: Map<string, Promise<void>>,
  executionId: string,
  executionTask: Promise<void>,
  startedEventTask: Promise<void>,
): Promise<string> {
  executionTasks.set(executionId, executionTask);
  void executionTask;
  await startedEventTask;
  return executionId;
}

/**
 * Load a workflow definition from storage and validate its steps.
 * @param bus - Message bus used for storage lookup.
 * @param workflowId - The workflow definition ID.
 * @returns The validated workflow definition.
 */
async function loadAndValidateWorkflow(bus: IMakaioBus, workflowId: string): Promise<WorkflowDefinition> {
  const { workflow } = await bus.request(WorkflowStorageSubjects.get, { id: workflowId });
  if (!workflow) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }
  // Step DAG validation removed: pipeline-primitive model validates at authoring time
  return workflow;
}

/** Options accepted by {@link startExecution}. */
export interface DefinitionStartOptions {
  /** Caller-supplied JSON input value. */
  readonly input?: JsonValue;
  /** Workflow configuration overrides. */
  readonly config?: Record<string, unknown>;
  /** Optional parent coordinator session. */
  readonly parentSessionId?: string;
  /** Optional trigger payload. */
  readonly triggerPayload?: Record<string, unknown>;
  /** Optional artifact binding reference. */
  readonly artifactRef?: WorkflowRunContext['artifactRef'];
  /** Optional execution scope override. */
  readonly scopeOverride?: WorkflowExecutionScope;
  /**
   * Optional provenance links to persist atomically with the execution start.
   * @param executionId - The generated target execution ID.
   * @returns Links that reference the generated execution.
   */
  readonly executionLinks?: (executionId: string) => readonly ExecutionLink[];
}

/**
 * Extended options for {@link startResolvedDefinitionExecution} that supply an
 * already-loaded workflow definition and optional source/snapshot overrides.
 *
 * Used by the rerun path to bypass the storage lookup and replay an execution
 * with either the original snapshot or the current definition.
 */
export interface ResolvedDefinitionStartOptions extends DefinitionStartOptions {
  /** Pre-loaded workflow definition to use for this execution. */
  readonly workflow: WorkflowDefinition;
  /**
   * Override for the execution source descriptor.
   * When omitted, defaults to `{ kind: 'definition', workflowId }`.
   */
  readonly executionSource?: WorkflowRunContext['source'];
  /**
   * Override for the definition snapshot stored on the run context.
   * When omitted, the Authority-pinned loaded workflow is stored.
   */
  readonly definitionSnapshot?: WorkflowDefinition;
  /** Portable workspace reference required when `executionSource.kind` is `path`. */
  readonly materializationSpec?: WorkflowRunContext['materializationSpec'];
}

/**
 * Create the coordinator session that owns a definition-backed execution.
 * @param bus - Bus used for session creation.
 * @param parentSessionId - Optional parent coordinator session.
 * @param workflowName - Human-readable workflow name for the session title.
 * @param workspaceRoot - Working directory assigned to the coordinator session.
 * @returns Created coordinator session ID.
 */
async function createDefinitionCoordinatorSession(
  bus: IMakaioBus,
  parentSessionId: string | undefined,
  workflowName: string | undefined,
  workspaceRoot: string,
): Promise<string> {
  const { sessionId } = await bus.request(SessionSubjects.create, {
    parentSessionId,
    branchKind: 'coordinator',
    title: `Workflow: ${workflowName}`,
    targetWorkingDirectory: workspaceRoot,
  });
  return sessionId;
}

/**
 * Start a new definition-backed workflow execution.
 *
 * Looks up the workflow from storage, seeds the execution record and
 * run-context snapshot, then dispatches to the configured runner or the
 * in-process step scheduler.
 * @param deps - Shared executor state and callbacks.
 * @param workflowId - The workflow definition ID.
 * @param options - Execution options.
 * @returns The new execution ID.
 */
export async function startExecution(
  deps: StartExecutionDeps,
  workflowId: string,
  options: DefinitionStartOptions = {},
): Promise<string> {
  const workflow = await loadAndValidateWorkflow(deps.bus, workflowId);
  return startResolvedDefinitionExecution(deps, workflowId, { ...options, workflow });
}

/**
 * Start a definition-backed execution with an already-resolved workflow definition.
 *
 * This is the core launch path shared by {@link startExecution} (which loads the
 * definition from storage first) and the rerun path (which supplies a snapshot
 * or freshly-loaded definition directly).
 * @param deps - Shared executor state and callbacks.
 * @param workflowId - The workflow definition ID.
 * @param options - Execution options including the pre-loaded workflow.
 * @returns The new execution ID.
 */
export async function startResolvedDefinitionExecution(
  deps: StartExecutionDeps,
  workflowId: string,
  options: ResolvedDefinitionStartOptions,
): Promise<string> {
  const { bus, activeExecutions, executionTasks } = deps;
  const { workflow, parentSessionId, triggerPayload, artifactRef, scopeOverride } = options;

  const executionId = generateId('wfx');
  const sanitizedTriggerPayload = sanitizeTriggerPayload(triggerPayload);
  const boundInputs = bindWorkflowInputs(workflow, options.input === undefined ? {} : options.input);
  const boundConfig = bindWorkflowConfig(workflow, options.config ?? {});
  const resolvedScope: WorkflowExecutionScope = scopeOverride ?? workflow.scope;
  const workspaceRoot = await deps.resolveExecutionWorkspaceRoot(parentSessionId);
  const executionSource = options.executionSource ?? resolveDefinitionExecutionSource(workflow, workflowId);
  // `workflow` was loaded or resolved by the Authority before dispatch. Persist
  // that exact immutable definition for every definition launch, including
  // path-backed runners, so remote finalization never trusts worker input.
  const definitionSnapshot = options.definitionSnapshot ?? workflow;
  const dispatch = selectDefinitionExecutionDispatch(deps, { workflow });
  assertRunnerBackedSourceDispatchAvailable(dispatch.runner, executionSource, workflowId);
  const { source: durableSource, materializationSpec } = await resolveDurablePathSource(
    deps,
    { executionId, workflowId, source: executionSource, workspaceRoot },
    options.materializationSpec,
  );

  const coordinatorSessionId = await createDefinitionCoordinatorSession(
    bus,
    parentSessionId,
    workflow.name,
    workspaceRoot,
  );

  let launched = false;
  try {
    const runContext = deps.buildRunContext({
      executionId,
      workflowId,
      coordinatorSessionId,
      source: durableSource,
      ...(definitionSnapshot !== undefined ? { definitionSnapshot } : {}),
      inputs: boundInputs,
      config: boundConfig,
      scope: resolvedScope,
      triggerPayload: sanitizedTriggerPayload ?? {},
      triggerMode: 'immediate',
      terminalAuthority: dispatch.runner?.terminalAuthority,
      ...(artifactRef !== undefined ? { artifactRef } : {}),
      ...(materializationSpec !== undefined ? { materializationSpec } : {}),
    });
    const execution = seedDefinitionExecution(
      activeExecutions,
      executionId,
      workflow,
      coordinatorSessionId,
      boundInputs,
      boundConfig,
      sanitizedTriggerPayload,
      resolvedScope,
      runContext,
    );
    const initialState = executionSource.kind === 'definition' ? getValidatedInitialWorkflowState(workflow) : undefined;
    await persistExecutionStart(bus, execution, runContext, initialState, options.executionLinks?.(executionId));

    const startedEventTask = emitExecutionStarted(bus, execution);
    const executionTask = launchDefinitionExecutionTask(
      deps,
      {
        executionId,
        workflowId,
        workflow,
        ...(shouldSendDefinitionToRunner(executionSource, options.definitionSnapshot) ? { definitionSnapshot } : {}),
        source: executionSource,
        coordinatorSessionId,
        sanitizedTriggerPayload: sanitizedTriggerPayload ?? {},
        boundInputs,
        boundConfig,
        scope: resolvedScope,
        ...(artifactRef !== undefined ? { artifactRef } : {}),
        suspensionStrategy: runContext.suspensionStrategy,
        ...(materializationSpec !== undefined ? { materializationSpec } : {}),
      },
      dispatch,
    );

    launched = true;
    return dispatchAndAwait(executionTasks, executionId, executionTask, startedEventTask);
  } catch (error) {
    if (!launched) {
      activeExecutions.delete(executionId);
      executionTasks.delete(executionId);
      await closeCoordinatorSession(bus, coordinatorSessionId);
    }
    throw error;
  }
}

/**
 * Seed the active-executions registry for an ephemeral file-backed execution.
 *
 * File-backed executions use a minimal stub workflow definition (empty root
 * sequence) because the actual definition is loaded inside the runner process.
 * @param activeExecutions - Live execution registry.
 * @param execution - The new `WorkflowExecution` record.
 * @param filePath - Source file path used as the workflow name fallback.
 * @param resolvedScope - Resolved execution scope for the stub definition.
 * @param runContext - Durable run-context snapshot for this execution.
 */
function seedFileExecution(
  activeExecutions: Map<string, ActiveExecution>,
  execution: WorkflowExecution,
  filePath: string,
  resolvedScope: WorkflowExecutionScope,
  runContext: WorkflowRunContext,
): void {
  activeExecutions.set(execution.id, {
    execution,
    workflow: {
      id: execution.workflowId,
      name: filePath,
      scope: resolvedScope,
      root: { id: `${execution.workflowId}-root`, type: 'sequence', nodes: [] },
    },
    runContext,
    runtimeHandlers: new Map(),
    runtimeLoopGates: new Map(),
  });
}

/**
 * Create the coordinator session that owns a file-backed execution.
 * @param bus - Bus used for session creation.
 * @param parentSessionId - Optional parent coordinator session.
 * @param filePath - Workflow file path used for the session title.
 * @param workspaceRoot - Working directory assigned to the coordinator session.
 * @returns Created coordinator session ID.
 */
async function createFileCoordinatorSession(
  bus: IMakaioBus,
  parentSessionId: string | undefined,
  filePath: string,
  workspaceRoot: string,
): Promise<string> {
  const { sessionId } = await bus.request(SessionSubjects.create, {
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    branchKind: 'coordinator',
    title: `Workflow: ${filePath}`,
    targetWorkingDirectory: workspaceRoot,
  });
  return sessionId;
}

/**
 * Require the runner needed by file-backed workflow execution.
 * @param runner - Configured workflow runner, when available.
 * @returns Configured workflow runner.
 */
function requireFileWorkflowRunner(runner: IWorkflowRunner | undefined): IWorkflowRunner {
  if (runner === undefined) throw new Error('[WorkflowExecutor] startFileExecution called without a workflow runner');
  return runner;
}

/**
 * Require a portable materialization specification for a path-backed workflow.
 * @param spec - Resolved materialization specification, when available.
 * @returns Resolved materialization specification.
 */
function requireFileMaterializationSpec(
  spec: WorkflowRunContext['materializationSpec'],
): NonNullable<WorkflowRunContext['materializationSpec']> {
  if (spec === undefined) {
    throw new Error('[WorkflowExecutor] path-backed execution requires a resolved materializationSpec');
  }
  return spec;
}

/**
 * Start a new workflow execution from a file path on disk.
 *
 * Unlike {@link startExecution}, this variant does not look up the workflow
 * from storage. The ephemeral execution is dispatched directly to the configured
 * {@link IWorkflowRunner} with a `path`-sourced {@link WorkflowWorkerConfig}.
 * The runner loads and validates the file.
 *
 * Only valid when a workflow runner is configured; the caller is responsible
 * for ensuring that precondition before calling this method.
 * @param deps - Shared executor state and callbacks.
 * @param filePath - Worker-local path to the workflow TypeScript or JavaScript file.
 * @param options - Execution options.
 * @returns The new execution ID.
 */
export async function startFileExecution(
  deps: StartExecutionDeps,
  filePath: string,
  options: Pick<
    DefinitionStartOptions,
    'artifactRef' | 'config' | 'executionLinks' | 'input' | 'parentSessionId' | 'scopeOverride' | 'triggerPayload'
  > & {
    /** Whether the worker executes immediately or waits for a declared trigger. */
    readonly triggerMode?: WorkflowTriggerMode;
    /**
     * Portable materialization specification for the path-backed workflow.
     *
     * Resolved by the host before persistence. Its source path becomes the
     * durable reference; `filePath` remains process-local execution input.
     */
    readonly materializationSpec?: WorkflowRunContext['materializationSpec'];
  } = {},
): Promise<string> {
  const { bus, activeExecutions, executionTasks } = deps;
  const { artifactRef, parentSessionId, triggerPayload, scopeOverride } = options;
  const triggerMode = options.triggerMode ?? 'immediate';
  const executionId = generateId('wfx');
  const sanitizedTriggerPayload = sanitizeTriggerPayload(triggerPayload);
  const boundInputs = options.input === undefined ? {} : options.input;
  const boundConfig = options.config ?? {};
  const resolvedScope: WorkflowExecutionScope = scopeOverride ?? { type: 'global' };
  const workspaceRoot = await deps.resolveExecutionWorkspaceRoot(parentSessionId);

  const workflowRunner = requireFileWorkflowRunner(deps.workflowRunner);

  // Ephemeral execution: use the execution ID as workflowId so storage does
  // not require a persisted file/source workflow definition row.
  const workflowId = executionId;
  const materializationSpec = requireFileMaterializationSpec(
    await resolveMaterializationSpec(
      deps,
      { executionId, workflowId, source: { kind: 'path', path: filePath }, workspaceRoot },
      options.materializationSpec,
    ),
  );
  const coordinatorSessionId = await createFileCoordinatorSession(bus, parentSessionId, filePath, workspaceRoot);
  const execution: WorkflowExecution = {
    id: executionId,
    workflowId,
    coordinatorSessionId,
    status: 'running',
    inputs: boundInputs,
    config: boundConfig,
    startedAt: Date.now(),
    triggerPayload: sanitizedTriggerPayload,
    ...(artifactRef !== undefined ? { artifactRef } : {}),
    scope: resolvedScope,
  };

  let launched = false;
  try {
    const runContext = deps.buildRunContext({
      executionId,
      workflowId,
      coordinatorSessionId,
      source: { kind: 'path', path: materializationSpec.sourcePath },
      inputs: boundInputs,
      config: boundConfig,
      scope: resolvedScope,
      triggerPayload: sanitizedTriggerPayload ?? {},
      triggerMode,
      terminalAuthority: workflowRunner.terminalAuthority,
      ...(artifactRef !== undefined ? { artifactRef } : {}),
      materializationSpec,
    });
    await persistExecutionStart(bus, execution, runContext, undefined, options.executionLinks?.(executionId));

    seedFileExecution(activeExecutions, execution, filePath, resolvedScope, runContext);

    const startedEventTask = emitExecutionStarted(bus, execution);
    const executionTask = buildFileExecutionTask(deps.buildRunnerTaskDeps(workflowRunner), {
      executionId,
      workflowId,
      filePath,
      coordinatorSessionId,
      sanitizedTriggerPayload: sanitizedTriggerPayload ?? {},
      triggerMode,
      boundInputs,
      boundConfig,
      ...(artifactRef !== undefined ? { artifactRef } : {}),
      scope: resolvedScope,
      materializationSpec,
    });

    launched = true;
    return dispatchAndAwait(executionTasks, executionId, executionTask, startedEventTask);
  } catch (error) {
    if (!launched) {
      activeExecutions.delete(executionId);
      executionTasks.delete(executionId);
      await closeCoordinatorSession(bus, coordinatorSessionId);
    }
    throw error;
  }
}
