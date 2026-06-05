import * as os from 'node:os';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  WORKFLOW_CANCELLED_REASON,
  createWorkflowCancelSubject,
  ExecutionHintsSchema,
  JsonValueSchema,
  type IWorkflowRunner,
  type IWorkflowTriggerTypeRegistry,
  type JsonValue,
  type WorkflowRunContext,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { WorkflowSubjects } from './namespace.js';
import { registerDrizzleWorkflowStorage } from './storage/handler.js';
import { DEFAULT_EXECUTOR_CONFIG, type ActiveRunnerStep, type ExecutorConfig, type ActiveExecution } from './types.js';
import {
  registerWorkflowStorageDelegationHandlers,
  registerWorkflowTriggerTypeHandlers,
} from './workflow-executor-handlers.js';
import {
  cancelExecution,
  completeExecutionWithFailure,
  completeExecutionWithSuccess,
  type FinalizerDeps,
} from './workflow-execution-finalizer.js';
import { resolveWorkerOs, type RunnerTaskDeps } from './workflow-runner-tasks.js';
import { startExecution, startFileExecution, type StartExecutionDeps } from './workflow-execution-start.js';
import { RuntimeContext } from './runtime/runtime-context.js';
import { executeSequence } from './runtime/primitive-runtime.js';
import type { NodeOutcome } from './runtime/node-execution.js';
import { resolveWorkflowArtifactBinding } from './artifact-context/artifact-binding.js';

/**
 * Normalize workflow.start input to the public JsonValue contract.
 * @param input - Request payload input value.
 * @returns The parsed JSON input, or undefined when omitted.
 */
function normalizeStartInput(input: unknown): JsonValue | undefined {
  if (input === undefined) {
    return undefined;
  }
  return JsonValueSchema.parse(input);
}

/**
 * Normalize workflow.start execution hints to the public opaque hints contract.
 * @param executionHints - Request payload hints value.
 * @returns Parsed execution hints, or undefined when omitted.
 */
function normalizeExecutionHints(executionHints: unknown): WorkflowRunContext['executionHints'] {
  if (executionHints === undefined) {
    return undefined;
  }
  return ExecutionHintsSchema.parse(executionHints);
}

/**
 * Core workflow executor service.
 *
 * Orchestrates workflow execution lifecycle:
 * - Creates coordinator session for each execution
 * - Executes steps via the mutable DAG scheduler
 * - Spawns subagents for each step
 * - Tracks progress and emits lifecycle events
 * - Manages cancellation and cleanup
 */
export class WorkflowExecutor extends BaseService {
  /** Drizzle storage handler registration for the composition root. */
  public static readonly storage = {
    drizzle: registerDrizzleWorkflowStorage,
  } as const;

  private readonly config: ExecutorConfig;
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private readonly executionTasks = new Map<string, Promise<void>>();
  private readonly shellAbortControllers = new Map<string, AbortController>();
  private readonly activeRunnerSteps = new Map<string, ActiveRunnerStep>();
  /**
   * Per-execution abort controllers used to cancel workflow-level runners.
   * Keyed by execution ID; only populated when a {@link IWorkflowRunner} is used.
   */
  private readonly workflowAbortControllers = new Map<string, AbortController>();
  private readonly workflowRunner?: IWorkflowRunner;
  private triggerTypeRegistry?: IWorkflowTriggerTypeRegistry;

  /**
   * Create a new workflow executor.
   * @param bus - The message bus for communication
   * @param config - Optional partial configuration (merged with defaults)
   * @param workflowRunner - Optional workflow-level runner for isolated execution
   */
  public constructor(bus: IMakaioBus, config?: Partial<ExecutorConfig>, workflowRunner?: IWorkflowRunner) {
    super(bus);
    this.config = { ...DEFAULT_EXECUTOR_CONFIG, ...config };
    this.workflowRunner = workflowRunner;
  }

  /**
   * Set the trigger type registry for listTriggerTypes support.
   * @param registry - Trigger type registry instance
   */
  public setTriggerTypeRegistry(registry: IWorkflowTriggerTypeRegistry): void {
    this.triggerTypeRegistry = registry;
  }

  /**
   * Retrieve the registry set via {@link setTriggerTypeRegistry}.
   *
   * The composition root calls this after boot to wire
   * `setWorkflowTriggerTypeRegistry` from `@makaio/kernel-core`.
   * @returns The trigger type registry, or `undefined` if not yet set.
   */
  public getTriggerTypeRegistry(): IWorkflowTriggerTypeRegistry | undefined {
    return this.triggerTypeRegistry;
  }

  /**
   * Build the `context` object for a {@link WorkflowWorkerConfig}.
   *
   * The context is derived from `ExecutorConfig.platformDefaults` and the
   * current process environment. `repoPath` is taken from the configured
   * working directory; `makaioHome` from the executor config when set,
   * otherwise from `MAKAIO_HOME` environment variable or `~/.makaio`.
   *
   * Workspace roots are execution-specific because parent sessions can carry
   * different target working directories.
   * @param workspaceRoot - Resolved workspace root for this execution.
   * @returns Fully populated workflow worker context.
   */
  private resolveWorkflowContext(workspaceRoot: string): WorkflowWorkerConfig['context'] {
    const makaioHome = this.config.makaioHome ?? process.env['MAKAIO_HOME'] ?? `${os.homedir()}/.makaio`;
    const resolvedOs = resolveWorkerOs(process.platform);

    return {
      repoPath: workspaceRoot,
      makaioHome,
      os: resolvedOs,
      arch: process.arch,
    };
  }

  /**
   * Register all bus handlers via BaseService lifecycle.
   * Called once by `init()` — idempotency is handled by BaseService.
   */
  protected onInit(): void {
    this.registerExecutionHandlers();
    for (const cleanup of registerWorkflowStorageDelegationHandlers(this.bus)) {
      this.addCleanup(cleanup);
    }
    for (const cleanup of registerWorkflowTriggerTypeHandlers(this.bus, () => this.triggerTypeRegistry)) {
      this.addCleanup(cleanup);
    }
  }

  /**
   * Release in-flight executions and abort shell processes.
   * Called by `destroy()` before handler unsubscription.
   */
  protected async onDestroy(): Promise<void> {
    const finalizerDeps = this.buildFinalizerDeps();
    // 1. Cancel all active executions (aborts controllers, schedules hard-kill timers).
    await Promise.allSettled(
      [...this.activeExecutions.keys()].map(async (executionId) => {
        const cancelled = await cancelExecution(finalizerDeps, executionId, 'Workflow engine shutdown');
        if (cancelled) {
          this.workflowAbortControllers.get(executionId)?.abort();
          this.workflowAbortControllers.delete(executionId);
        }
      }),
    );
    // 2. Abort all pending workflow-level runners (cooperative cancellation).
    for (const controller of this.workflowAbortControllers.values()) {
      controller.abort();
    }
    this.workflowAbortControllers.clear();
    // 3. Await all execution tasks to settle (runners terminate via abort or forceKill).
    await Promise.allSettled(this.executionTasks.values());
    // 4. Clean up remaining timers and maps after all tasks have settled.
    for (const controller of this.shellAbortControllers.values()) {
      controller.abort();
    }
    this.shellAbortControllers.clear();
    for (const entry of this.activeRunnerSteps.values()) {
      if (entry.hardKillTimer) clearTimeout(entry.hardKillTimer);
    }
    this.activeRunnerSteps.clear();
    await this.workflowRunner?.dispose?.();
    this.activeExecutions.clear();
  }

  /**
   * Build a {@link FinalizerDeps} bundle from current instance state.
   *
   * Extracted to avoid duplicating the same field enumeration across the cancel
   * handler, the shutdown path, and the runner rejection catch path.
   * @returns Finalizer dependency bundle.
   */
  private buildFinalizerDeps(): FinalizerDeps {
    return {
      bus: this.bus,
      activeExecutions: this.activeExecutions,
      shellAbortControllers: this.shellAbortControllers,
      activeRunnerSteps: this.activeRunnerSteps,
      cancelTimeoutMs: this.config.cancelTimeoutMs,
    };
  }

  /**
   * Build a {@link RunnerTaskDeps} bundle for delegating to
   * {@link buildExecutionTask} or {@link buildFileExecutionTask}.
   * @param workflowRunner - The runner instance to use (always defined at these call sites).
   * @returns Runner task dependency bundle.
   */
  private buildRunnerTaskDeps(workflowRunner: IWorkflowRunner): RunnerTaskDeps {
    return {
      workflowRunner,
      workflowAbortControllers: this.workflowAbortControllers,
      executionTasks: this.executionTasks,
      activeExecutions: this.activeExecutions,
      buildFinalizerDeps: () => this.buildFinalizerDeps(),
      resolveWorkflowContext: (workspaceRoot) => this.resolveWorkflowContext(workspaceRoot),
      config: this.config,
    };
  }

  /**
   * Resolve the workspace root inherited from a parent session.
   *
   * Coordinator sessions are created with this target working directory so
   * in-process shell steps and workflow-level workers share the same workspace.
   * @param parentSessionId - Optional parent session identifier.
   * @returns Parent session working directory, or the executor default cwd.
   */
  private async resolveExecutionWorkspaceRoot(parentSessionId?: string): Promise<string> {
    if (!parentSessionId) {
      return this.config.platformDefaults.cwd;
    }

    const { session } = await this.bus.request(SessionSubjects.get, { sessionId: parentSessionId });
    return session?.targetWorkingDirectory ?? this.config.platformDefaults.cwd;
  }

  /**
   * Build the {@link StartExecutionDeps} bundle used by {@link startExecution}
   * and {@link startFileExecution}.
   * @returns Start execution dependency bundle.
   */
  private buildStartDeps(): StartExecutionDeps {
    return {
      bus: this.bus,
      config: this.config,
      activeExecutions: this.activeExecutions,
      executionTasks: this.executionTasks,
      workflowRunner: this.workflowRunner,
      buildRunContext: (params) => this.buildRunContext(params),
      buildRunnerTaskDeps: (runner) => this.buildRunnerTaskDeps(runner),
      buildFinalizerDeps: () => this.buildFinalizerDeps(),
      resolveExecutionWorkspaceRoot: (parentSessionId) => this.resolveExecutionWorkspaceRoot(parentSessionId),
      runExecution: (executionId) => this.runExecution(executionId),
    };
  }

  /**
   * Build a {@link WorkflowRunContext} from the invariant fields common to all
   * execution start paths (workerManifest, cancelSubject, context, env, createdAt)
   * merged with the caller-specific source, definitionSnapshot, inputs and scope.
   * @param params - Variant fields unique to each start path.
   * @returns Fully populated run context ready for persistence.
   */
  private buildRunContext({
    executionId,
    workflowId,
    coordinatorSessionId,
    source,
    definitionSnapshot,
    inputs,
    config,
    scope,
    triggerPayload,
    artifactRef,
    executionHints,
    workspaceRoot,
  }: {
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
  }): WorkflowRunContext {
    return {
      executionId,
      workflowId,
      source,
      ...(definitionSnapshot !== undefined ? { definitionSnapshot } : {}),
      workerManifest: { packages: [] },
      inputs,
      config,
      scope,
      triggerPayload,
      ...(artifactRef !== undefined ? { artifactRef } : {}),
      ...(executionHints !== undefined ? { executionHints } : {}),
      coordinatorSessionId,
      cancelSubject: `workflow.${executionId}.cancel`,
      context: this.resolveWorkflowContext(workspaceRoot),
      env: this.config.platformDefaults.env ?? {},
      createdAt: Date.now(),
    };
  }

  /** Register execution control handlers (start, cancel). */
  private registerExecutionHandlers(): void {
    this.registerHandler(WorkflowSubjects.start, async (ctx) => {
      const { workflowId, input, config, parentSessionId, triggerPayload, artifactRef, scope, executionHints } =
        ctx.payload;
      const workflowConfig: Record<string, unknown> =
        config !== null && typeof config === 'object' && !Array.isArray(config)
          ? (config as Record<string, unknown>)
          : {};
      try {
        const executionId = await startExecution(this.buildStartDeps(), workflowId, {
          input: normalizeStartInput(input),
          config: workflowConfig,
          parentSessionId,
          triggerPayload,
          artifactRef,
          executionHints: normalizeExecutionHints(executionHints),
          scopeOverride: scope,
        });
        ctx.setResult({ executionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to start workflow: ${message}`);
      }
    });

    this.registerHandler(WorkflowSubjects.runFile, async (ctx) => {
      if (this.workflowRunner === undefined) {
        throw new Error(
          'workflow.runFile requires a workflow runner — configure a ThinWorkflowPiscinaRunner or equivalent.',
        );
      }
      const { filePath, triggerPayload, scope } = ctx.payload;
      try {
        const executionId = await startFileExecution(this.buildStartDeps(), filePath, {
          triggerPayload,
          scopeOverride: scope,
        });
        ctx.setResult({ executionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to start workflow file: ${message}`);
      }
    });

    this.registerHandler(WorkflowSubjects.cancel, async (ctx) => {
      const { executionId, reason } = ctx.payload;
      // Emit the per-execution cancel subject before terminalizing local state
      // so that remote workers subscribed via their bus connection can abort
      // cooperatively before we forcefully clean up local execution state.
      await this.bus
        .emit(createWorkflowCancelSubject(`workflow.${executionId}.cancel`), { executionId, reason })
        .catch((error: unknown) => {
          console.error(`[WorkflowExecutor] Failed to emit workflow cancel for ${executionId}:`, error);
        });

      const workflowController = this.workflowAbortControllers.get(executionId);
      if (workflowController) {
        workflowController.abort(reason ?? WORKFLOW_CANCELLED_REASON);
        const cancelled = await cancelExecution(this.buildFinalizerDeps(), executionId, reason);
        ctx.setResult({ cancelled });
        return;
      }

      const finalizerDeps = this.buildFinalizerDeps();
      const cancelled = await cancelExecution(finalizerDeps, executionId, reason);
      ctx.setResult({ cancelled });
    });
  }

  /**
   * Main execution loop — drives the primitive runtime over the workflow's
   * root sequence node.
   *
   * Creates a per-execution `RuntimeContext` and `AbortController`, then
   * delegates to {@link executeSequence} to walk the node tree. The abort
   * controller is registered in `workflowAbortControllers` so the cancel
   * handler can interrupt a running execution.
   * @param executionId - The execution ID.
   */
  private async runExecution(executionId: string): Promise<void> {
    const active = this.activeExecutions.get(executionId);
    if (!active) return;

    const abortController = new AbortController();
    this.workflowAbortControllers.set(executionId, abortController);

    try {
      let outcome: NodeOutcome;
      try {
        const artifactBinding = await resolveWorkflowArtifactBinding({
          definition: active.workflow,
          execution: active.execution,
          runContext: active.runContext,
          bus: this.bus,
        });
        const runtimeCtx = new RuntimeContext(
          executionId,
          active.workflow.id,
          active.workflow,
          active.execution,
          active.runtimeHandlers,
          this.bus,
          abortController.signal,
          undefined,
          artifactBinding,
          { context: active.runContext.context, env: active.runContext.env },
        );
        const expressionCtx = runtimeCtx.buildExpressionContext();
        outcome = await executeSequence(active.workflow.root, runtimeCtx, expressionCtx);
      } catch (error) {
        if (abortController.signal.aborted || active.execution.status === 'cancelled') {
          await cancelExecution(this.buildFinalizerDeps(), executionId, WORKFLOW_CANCELLED_REASON);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        await completeExecutionWithFailure(this.buildFinalizerDeps(), active.execution, executionId, message);
        return;
      }

      const finalizerDeps = this.buildFinalizerDeps();
      if (outcome.status === 'cancelled' || abortController.signal.aborted || active.execution.status === 'cancelled') {
        await cancelExecution(finalizerDeps, executionId, WORKFLOW_CANCELLED_REASON);
      } else if (outcome.status === 'failed') {
        await completeExecutionWithFailure(finalizerDeps, active.execution, executionId, outcome.error);
      } else {
        await completeExecutionWithSuccess(finalizerDeps, active.execution, executionId, active.execution.startedAt);
      }
    } finally {
      this.workflowAbortControllers.delete(executionId);
    }
  }
}
