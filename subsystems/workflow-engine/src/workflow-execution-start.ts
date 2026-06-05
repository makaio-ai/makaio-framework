import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  type IWorkflowRunner,
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
import { buildInitialStepStates, validateAuthoredWorkflowSteps } from './dag-utils.js';
import {
  bindWorkflowInputs,
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
    scope: WorkflowRunContext['scope'];
    triggerPayload: WorkflowRunContext['triggerPayload'];
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
 * @param boundInputs - Resolved input values.
 * @param sanitizedTriggerPayload - Sanitized trigger payload (may be null).
 * @param resolvedScope - Resolved execution scope.
 * @returns The newly constructed execution record.
 */
function seedDefinitionExecution(
  activeExecutions: Map<string, ActiveExecution>,
  executionId: string,
  workflow: WorkflowDefinition,
  coordinatorSessionId: string,
  boundInputs: Record<string, unknown>,
  sanitizedTriggerPayload: Record<string, unknown> | undefined,
  resolvedScope: WorkflowExecutionScope,
): WorkflowExecution {
  const execution: WorkflowExecution = {
    id: executionId,
    workflowId: workflow.id,
    coordinatorSessionId,
    status: 'running',
    inputs: boundInputs,
    steps: buildInitialStepStates(workflow.steps),
    startedAt: Date.now(),
    triggerPayload: sanitizedTriggerPayload,
    scope: resolvedScope,
  };
  const stepMap = new Map(workflow.steps.map((step) => [step.id, step]));
  activeExecutions.set(executionId, { execution, workflow, stepMap, stepContext: new Map() });
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
  validateAuthoredWorkflowSteps(workflow.steps);
  return workflow;
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
  options: {
    inputs?: Record<string, unknown>;
    parentSessionId?: string;
    triggerPayload?: Record<string, unknown>;
    scopeOverride?: WorkflowExecutionScope;
  } = {},
): Promise<string> {
  const { bus, activeExecutions, executionTasks } = deps;
  const { inputs = {}, parentSessionId, triggerPayload, scopeOverride } = options;

  const workflow = await loadAndValidateWorkflow(bus, workflowId);
  const executionId = generateId('wfx');
  const sanitizedTriggerPayload = sanitizeTriggerPayload(triggerPayload);
  const boundInputs = bindWorkflowInputs(workflow.inputs, inputs);
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
    const execution = seedDefinitionExecution(
      activeExecutions,
      executionId,
      workflow,
      coordinatorSessionId,
      boundInputs,
      sanitizedTriggerPayload,
      resolvedScope,
    );
    await persistExecutionStart(
      bus,
      execution,
      deps.buildRunContext({
        executionId,
        workflowId,
        coordinatorSessionId,
        source: { kind: 'definition', workflowId },
        definitionSnapshot: workflow,
        inputs: boundInputs,
        scope: resolvedScope,
        triggerPayload: sanitizedTriggerPayload ?? {},
        workspaceRoot,
      }),
    );

    const startedEventTask = emitExecutionStarted(bus, { executionId, workflowId, coordinatorSessionId });
    const executionTask =
      deps.workflowRunner !== undefined
        ? buildExecutionTask(deps.buildRunnerTaskDeps(deps.workflowRunner), {
            executionId,
            workflowId,
            workflow,
            coordinatorSessionId,
            sanitizedTriggerPayload: sanitizedTriggerPayload ?? {},
            boundInputs,
            scope: resolvedScope,
            workspaceRoot,
          })
        : deps.runExecution(executionId).finally(() => {
            executionTasks.delete(executionId);
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
    steps: {},
    startedAt: Date.now(),
    triggerPayload: sanitizedTriggerPayload,
    scope: resolvedScope,
  };

  let launched = false;
  try {
    await persistExecutionStart(
      bus,
      execution,
      deps.buildRunContext({
        executionId,
        workflowId,
        coordinatorSessionId,
        source: { kind: 'path', path: filePath },
        inputs: {},
        scope: resolvedScope,
        triggerPayload: sanitizedTriggerPayload ?? {},
        workspaceRoot,
      }),
    );

    // The runner manages the full execution lifecycle (step events, completion).
    // Register a minimal ActiveExecution entry so cancellation and shutdown
    // can abort the runner via workflowAbortControllers.
    activeExecutions.set(executionId, {
      execution,
      workflow: { id: workflowId, name: filePath, scope: resolvedScope, steps: [], createdAt: 0, updatedAt: 0 },
      stepMap: new Map(),
      stepContext: new Map(),
    });

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
