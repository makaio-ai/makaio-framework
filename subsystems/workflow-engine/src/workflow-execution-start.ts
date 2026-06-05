import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  type IWorkflowRunner,
  type JsonValue,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowExecutionScope,
  type WorkflowRunContext,
} from '@makaio/contracts';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import { type ExecutorConfig, type ActiveExecution } from './types.js';
import { generateId } from './executor-helpers.js';
import { sanitizeTriggerPayload } from './trigger-payload-sanitizer.js';
import { type FinalizerDeps } from './workflow-execution-finalizer.js';
// dag-utils import removed: step DAG replaced by primitive runtime frame model
import {
  bindWorkflowInputs,
  bindWorkflowConfig,
  buildExecutionTask,
  buildFileExecutionTask,
  type RunnerTaskDeps,
} from './workflow-runner-tasks.js';

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
 * Emit the execution-started lifecycle event without letting observer failures
 * prevent an already-persisted execution from running.
 * @param bus - Message bus
 * @param payload - Execution lifecycle payload
 */
async function emitExecutionStarted(
  bus: IMakaioBus,
  payload: { executionId: string; workflowId: string; coordinatorSessionId: string },
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
 */
async function persistExecutionStart(
  bus: IMakaioBus,
  execution: WorkflowExecution,
  runContext: WorkflowRunContext,
): Promise<void> {
  await bus.request(WorkflowStorageSubjects.setExecutionStart, { execution, runContext });
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
 * Dispatch a definition-backed execution through the configured runner, or run
 * it in-process when no isolated runner is configured.
 * @param deps - Shared executor state and callbacks.
 * @param params - Bound execution data needed by the runner task.
 * @returns Settled execution task promise.
 */
function launchDefinitionExecutionTask(
  deps: StartExecutionDeps,
  params: {
    executionId: string;
    workflowId: string;
    workflow: WorkflowDefinition;
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
  if (deps.workflowRunner !== undefined) {
    return buildExecutionTask(deps.buildRunnerTaskDeps(deps.workflowRunner), params);
  }
  return deps.runExecution(params.executionId).finally(() => {
    deps.executionTasks.delete(params.executionId);
  });
}

/** Options accepted by {@link startExecution}. */
interface DefinitionStartOptions {
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
}

/** Normalized definition execution start options. */
interface NormalizedDefinitionStartOptions extends Omit<DefinitionStartOptions, 'config' | 'input'> {
  /** Caller-supplied JSON input value. */
  readonly input: JsonValue;
  /** Workflow configuration overrides. */
  readonly config: Record<string, unknown>;
}

/**
 * Normalize start options while preserving scalar and array workflow inputs.
 * @param options - Raw start options.
 * @returns Options with defaults applied.
 */
function normalizeDefinitionStartOptions(options: DefinitionStartOptions): NormalizedDefinitionStartOptions {
  return {
    ...options,
    input: options.input === undefined ? {} : options.input,
    config: options.config ?? {},
  };
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
  const { bus, activeExecutions, executionTasks } = deps;
  const { input, config, parentSessionId, triggerPayload, artifactRef, executionHints, scopeOverride } =
    normalizeDefinitionStartOptions(options);

  const workflow = await loadAndValidateWorkflow(bus, workflowId);
  const executionId = generateId('wfx');
  const sanitizedTriggerPayload = sanitizeTriggerPayload(triggerPayload);
  const boundInputs = bindWorkflowInputs(workflow, input);
  const boundConfig = bindWorkflowConfig(workflow, config);
  const resolvedScope: WorkflowExecutionScope = scopeOverride ?? workflow.scope;
  const workspaceRoot = await deps.resolveExecutionWorkspaceRoot(parentSessionId);

  const { sessionId: coordinatorSessionId } = await bus.request(SessionSubjects.create, {
    parentSessionId,
    branchKind: 'coordinator',
    title: `Workflow: ${workflow.name}`,
    targetWorkingDirectory: workspaceRoot,
  });

  let launched = false;
  try {
    const runContext = deps.buildRunContext({
      executionId,
      workflowId,
      coordinatorSessionId,
      source: { kind: 'definition', workflowId },
      definitionSnapshot: workflow,
      inputs: boundInputs,
      config: boundConfig,
      scope: resolvedScope,
      triggerPayload: sanitizedTriggerPayload ?? {},
      ...(artifactRef !== undefined ? { artifactRef } : {}),
      ...(executionHints !== undefined ? { executionHints } : {}),
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
    await persistExecutionStart(bus, execution, runContext);

    const startedEventTask = emitExecutionStarted(bus, { executionId, workflowId, coordinatorSessionId });
    const executionTask = launchDefinitionExecutionTask(deps, {
      executionId,
      workflowId,
      workflow,
      coordinatorSessionId,
      sanitizedTriggerPayload: sanitizedTriggerPayload ?? {},
      boundInputs,
      boundConfig,
      scope: resolvedScope,
      ...(artifactRef !== undefined ? { artifactRef } : {}),
      ...(executionHints !== undefined ? { executionHints } : {}),
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
  options: {
    triggerPayload?: Record<string, unknown>;
    scopeOverride?: WorkflowExecutionScope;
  } = {},
): Promise<string> {
  const { bus, config, activeExecutions, executionTasks } = deps;
  const { triggerPayload, scopeOverride } = options;
  const executionId = generateId('wfx');
  const sanitizedTriggerPayload = sanitizeTriggerPayload(triggerPayload);
  const resolvedScope: WorkflowExecutionScope = scopeOverride ?? { type: 'global' };
  const workspaceRoot = config.platformDefaults.cwd;

  const { sessionId: coordinatorSessionId } = await bus.request(SessionSubjects.create, {
    branchKind: 'coordinator',
    title: `Workflow: ${filePath}`,
    targetWorkingDirectory: workspaceRoot,
  });

  // Ephemeral execution: use the execution ID as workflowId so storage does
  // not require a persisted file/source workflow definition row.
  const workflowId = executionId;
  const execution: WorkflowExecution = {
    id: executionId,
    workflowId,
    coordinatorSessionId,
    status: 'running',
    inputs: {},
    config: {},
    startedAt: Date.now(),
    triggerPayload: sanitizedTriggerPayload,
    scope: resolvedScope,
  };

  let launched = false;
  try {
    const runContext = deps.buildRunContext({
      executionId,
      workflowId,
      coordinatorSessionId,
      source: { kind: 'path', path: filePath },
      inputs: {},
      config: {},
      scope: resolvedScope,
      triggerPayload: sanitizedTriggerPayload ?? {},
      workspaceRoot,
    });
    await persistExecutionStart(bus, execution, runContext);

    seedFileExecution(activeExecutions, execution, filePath, resolvedScope, runContext);

    const startedEventTask = emitExecutionStarted(bus, { executionId, workflowId, coordinatorSessionId });
    // workflowRunner presence is enforced by the runFile handler before
    // startFileExecution is called — this guard is a defensive belt-and-suspenders
    // check that also satisfies the type narrowing without a non-null assertion.
    const { workflowRunner } = deps;
    if (workflowRunner === undefined) {
      throw new Error('[WorkflowExecutor] startFileExecution called without a workflow runner');
    }
    const executionTask = buildFileExecutionTask(deps.buildRunnerTaskDeps(workflowRunner), {
      executionId,
      workflowId,
      filePath,
      coordinatorSessionId,
      sanitizedTriggerPayload: sanitizedTriggerPayload ?? {},
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
