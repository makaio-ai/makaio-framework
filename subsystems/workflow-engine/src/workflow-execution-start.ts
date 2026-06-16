/* eslint max-lines: ["error", { "max": 500, "skipBlankLines": true, "skipComments": true }], max-lines-per-function: ["error", { "max": 90, "skipBlankLines": true, "skipComments": true }] */
import { isAbsolute, resolve } from 'node:path';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  WorkflowWorkerSourceSchema,
  type ExecutionHints,
  type ExecutionLink,
  type IWorkflowRunner,
  type JsonValue,
  type WorkflowArtifactRef,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowExecutionScope,
  type WorkflowRunContext,
  type WorkflowWorkerSource,
} from '@makaio/contracts';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import { type ExecutorConfig, type ActiveExecution } from './types.js';
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
import { launchDefinitionExecutionTask } from './workflow-definition-dispatch.js';

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
    artifactRef?: WorkflowRunContext['artifactRef'];
    executionHints?: WorkflowRunContext['executionHints'];
    workspaceRoot: string;
    suspensionStrategy?: WorkflowRunContext['suspensionStrategy'];
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
 * @param payload - Execution lifecycle payload
 */
async function emitExecutionStarted(
  bus: IMakaioBus,
  payload: {
    executionId: string;
    workflowId: string;
    coordinatorSessionId: string;
    startedAt: number;
    artifactRef?: WorkflowArtifactRef;
  },
): Promise<void> {
  try {
    await bus.emit(WorkflowSubjects.execution.started, payload);
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
 * Resolve an optional executable source from merged execution hints.
 *
 * Generated definitions may exist only as trigger/provenance metadata while
 * their actual runtime lives in a workflow module. A validated source hint lets
 * the generic workflow executor dispatch those definitions through the same
 * worker loading path as `workflow.runFile`, without coupling framework code to
 * any product extension.
 * @param executionHints - Merged definition/request execution hints.
 * @param workspaceRoot - Workspace root used to resolve relative path sources.
 * @returns Worker source override, or `undefined` to use definition-sourced execution.
 */
function resolveExecutionHintSource(
  executionHints: WorkflowRunContext['executionHints'],
  workspaceRoot: string,
): WorkflowWorkerSource | undefined {
  const source = executionHints?.source;
  if (source === undefined) {
    return undefined;
  }

  const parsed = WorkflowWorkerSourceSchema.parse(source);
  if (parsed.kind === 'path' && !isAbsolute(parsed.path)) {
    return { ...parsed, path: resolve(workspaceRoot, parsed.path) };
  }
  return parsed;
}

/**
 * Resolve the worker source for a definition-backed execution.
 * @param workflowId - The workflow definition ID.
 * @param executionHints - Merged definition/request execution hints.
 * @param workspaceRoot - Workspace root used to resolve relative path sources.
 * @returns The explicit hint source or the default definition source.
 */
function resolveDefinitionExecutionSource(
  workflowId: string,
  executionHints: WorkflowRunContext['executionHints'],
  workspaceRoot: string,
): WorkflowWorkerSource {
  return resolveExecutionHintSource(executionHints, workspaceRoot) ?? { kind: 'definition', workflowId };
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

/**
 * Merge requirements from two hint sources, unioning capabilities.
 *
 * Capabilities from both sources are deduplicated so no tag is required twice.
 * When neither source contributes requirements, returns `undefined`.
 * @param def - Requirements from the stored workflow definition.
 * @param req - Requirements from the per-call execution start request.
 * @returns Merged requirements, or `undefined` when both are absent.
 */
function mergeRequirements(
  def: ExecutionHints['requirements'],
  req: ExecutionHints['requirements'],
): ExecutionHints['requirements'] {
  if (def === undefined && req === undefined) {
    return undefined;
  }
  const caps = [...new Set([...(def?.capabilities ?? []), ...(req?.capabilities ?? [])])];
  return {
    ...def,
    ...req,
    ...(caps.length > 0 && { capabilities: caps }),
  };
}

/**
 * Merge definition-level execution hints with per-call overrides.
 *
 * Merge semantics:
 * - Request values win over definition defaults on all scalar fields.
 * - `requirements.capabilities` arrays are unioned and deduplicated so both
 *   the definition's declared needs and the caller's runtime needs are satisfied.
 * - `providers` records are merged shallowly (request entries override).
 *
 * Returns `undefined` when both sources are absent or empty.
 * @param definitionHints - Hints baked into the stored workflow definition.
 * @param requestHints - Per-call hints supplied by the execution starter.
 * @returns Merged hints, or `undefined` when neither source contributes values.
 */
export function mergeExecutionHints(
  definitionHints: ExecutionHints | undefined,
  requestHints: ExecutionHints | undefined,
): ExecutionHints | undefined {
  if (definitionHints === undefined && requestHints === undefined) {
    return undefined;
  }

  const requirements = mergeRequirements(definitionHints?.requirements, requestHints?.requirements);
  const hasProviders = definitionHints?.providers !== undefined || requestHints?.providers !== undefined;
  const providers = hasProviders ? { ...definitionHints?.providers, ...requestHints?.providers } : undefined;

  return {
    ...definitionHints,
    ...requestHints,
    ...(requirements !== undefined && { requirements }),
    ...(providers !== undefined && { providers }),
  };
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
  /** Optional worker provisioning hints. */
  readonly executionHints?: WorkflowRunContext['executionHints'];
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
   * When omitted, the source is resolved from execution hints or defaults to
   * `{ kind: 'definition', workflowId }`.
   */
  readonly executionSource?: WorkflowRunContext['source'];
  /**
   * Override for the definition snapshot stored on the run context.
   * When omitted, the snapshot is derived from the execution source kind.
   */
  readonly definitionSnapshot?: WorkflowDefinition;
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
  const { workflow, parentSessionId, triggerPayload, artifactRef, executionHints, scopeOverride } = options;
  const input = options.input === undefined ? {} : options.input;
  const config = options.config ?? {};

  const executionId = generateId('wfx');
  const sanitizedTriggerPayload = sanitizeTriggerPayload(triggerPayload);
  const boundInputs = bindWorkflowInputs(workflow, input);
  const boundConfig = bindWorkflowConfig(workflow, config);
  const resolvedScope: WorkflowExecutionScope = scopeOverride ?? workflow.scope;
  const mergedExecutionHints = mergeExecutionHints(workflow.executionHints, executionHints);
  const workspaceRoot = await deps.resolveExecutionWorkspaceRoot(parentSessionId);
  const executionSource =
    options.executionSource ?? resolveDefinitionExecutionSource(workflowId, mergedExecutionHints, workspaceRoot);
  const definitionSnapshot =
    options.definitionSnapshot ?? (executionSource.kind === 'definition' ? workflow : undefined);

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
      source: executionSource,
      ...(definitionSnapshot !== undefined ? { definitionSnapshot } : {}),
      inputs: boundInputs,
      config: boundConfig,
      scope: resolvedScope,
      triggerPayload: sanitizedTriggerPayload ?? {},
      ...(artifactRef !== undefined ? { artifactRef } : {}),
      ...(mergedExecutionHints !== undefined ? { executionHints: mergedExecutionHints } : {}),
      workspaceRoot,
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

    const startedAt = execution.startedAt;
    const startedEventTask = emitExecutionStarted(bus, {
      executionId,
      workflowId,
      coordinatorSessionId,
      startedAt,
      ...(artifactRef !== undefined ? { artifactRef } : {}),
    });
    const executionTask = launchDefinitionExecutionTask(deps, {
      executionId,
      workflowId,
      workflow,
      ...(definitionSnapshot !== undefined ? { definitionSnapshot } : {}),
      source: executionSource,
      coordinatorSessionId,
      sanitizedTriggerPayload: sanitizedTriggerPayload ?? {},
      boundInputs,
      boundConfig,
      scope: resolvedScope,
      ...(artifactRef !== undefined ? { artifactRef } : {}),
      ...(mergedExecutionHints !== undefined ? { executionHints: mergedExecutionHints } : {}),
      workspaceRoot,
      suspensionStrategy: runContext.suspensionStrategy,
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
 * @param filePath - Absolute path to the workflow TypeScript or JavaScript file.
 * @param options - Execution options.
 * @returns The new execution ID.
 */
export async function startFileExecution(
  deps: StartExecutionDeps,
  filePath: string,
  options: Pick<
    DefinitionStartOptions,
    | 'artifactRef'
    | 'config'
    | 'executionHints'
    | 'executionLinks'
    | 'input'
    | 'parentSessionId'
    | 'scopeOverride'
    | 'triggerPayload'
  > = {},
): Promise<string> {
  const { bus, activeExecutions, executionTasks } = deps;
  const { artifactRef, executionHints, parentSessionId, triggerPayload, scopeOverride } = options;
  const executionId = generateId('wfx');
  const sanitizedTriggerPayload = sanitizeTriggerPayload(triggerPayload);
  const boundInputs = options.input === undefined ? {} : options.input;
  const boundConfig = options.config ?? {};
  const resolvedScope: WorkflowExecutionScope = scopeOverride ?? { type: 'global' };
  const workspaceRoot = await deps.resolveExecutionWorkspaceRoot(parentSessionId);
  const coordinatorSessionId = await createFileCoordinatorSession(bus, parentSessionId, filePath, workspaceRoot);

  // Ephemeral execution: use the execution ID as workflowId so storage does
  // not require a persisted file/source workflow definition row.
  const workflowId = executionId;
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
    // workflowRunner presence is enforced by the runFile handler before
    // startFileExecution is called — this guard is a defensive belt-and-suspenders
    // check that also satisfies the type narrowing without a non-null assertion.
    const { workflowRunner } = deps;
    if (workflowRunner === undefined) {
      throw new Error('[WorkflowExecutor] startFileExecution called without a workflow runner');
    }

    const runContext = deps.buildRunContext({
      executionId,
      workflowId,
      coordinatorSessionId,
      source: { kind: 'path', path: filePath },
      inputs: boundInputs,
      config: boundConfig,
      scope: resolvedScope,
      triggerPayload: sanitizedTriggerPayload ?? {},
      ...(artifactRef !== undefined ? { artifactRef } : {}),
      ...(executionHints !== undefined ? { executionHints } : {}),
      workspaceRoot,
    });
    await persistExecutionStart(bus, execution, runContext, undefined, options.executionLinks?.(executionId));

    seedFileExecution(activeExecutions, execution, filePath, resolvedScope, runContext);

    const startedEventTask = emitExecutionStarted(bus, {
      executionId,
      workflowId,
      coordinatorSessionId,
      startedAt: execution.startedAt,
      ...(artifactRef !== undefined ? { artifactRef } : {}),
    });
    const executionTask = buildFileExecutionTask(deps.buildRunnerTaskDeps(workflowRunner), {
      executionId,
      workflowId,
      filePath,
      coordinatorSessionId,
      sanitizedTriggerPayload: sanitizedTriggerPayload ?? {},
      boundInputs,
      boundConfig,
      ...(artifactRef !== undefined ? { artifactRef } : {}),
      ...(executionHints !== undefined ? { executionHints } : {}),
      scope: resolvedScope,
      workspaceRoot,
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
