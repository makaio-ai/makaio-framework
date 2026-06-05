import * as os from 'node:os';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  SubagentSubjects,
  WORKFLOW_CANCELLED_REASON,
  createWorkflowCancelSubject,
  type IStepRunner,
  type IWorkflowRunner,
  type IWorkflowTriggerTypeRegistry,
  type WorkflowExecution,
  type WorkflowExecutionScope,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import { registerDrizzleWorkflowStorage } from './storage/handler.js';
import { DEFAULT_EXECUTOR_CONFIG, type ActiveRunnerStep, type ExecutorConfig, type ActiveExecution } from './types.js';
import { generateId } from './executor-helpers.js';
import { sanitizeTriggerPayload } from './trigger-payload-sanitizer.js';
import {
  registerWorkflowStorageDelegationHandlers,
  registerWorkflowTriggerTypeHandlers,
} from './workflow-executor-handlers.js';
import { cancelExecution, type FinalizerDeps } from './workflow-execution-finalizer.js';
import { WorkflowGateCoordinator } from './workflow-gate-coordinator.js';
import { InProcessStepRunner } from './in-process-step-runner.js';
import { WorkflowScheduler } from './workflow-scheduler.js';
import { buildInitialStepStates, validateAuthoredWorkflowSteps } from './dag-utils.js';
import {
  resolveWorkerOs,
  bindWorkflowInputs,
  buildExecutionTask,
  buildFileExecutionTask,
  type RunnerTaskDeps,
} from './workflow-runner-tasks.js';

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
  private readonly gateCoordinator: WorkflowGateCoordinator;
  private readonly stepRunner: IStepRunner;
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
    this.gateCoordinator = new WorkflowGateCoordinator(bus);
    this.workflowRunner = workflowRunner;
    this.stepRunner = new InProcessStepRunner({
      bus,
      activeExecutions: this.activeExecutions,
      shellAbortControllers: this.shellAbortControllers,
      gateCoordinator: this.gateCoordinator,
      config: this.config,
    });
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
    this.gateCoordinator.registerResponseHandler((cleanup) => this.addCleanup(cleanup));
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
    this.gateCoordinator.dispose();
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
    await this.stepRunner.dispose?.();
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
      stepRunner: this.stepRunner,
      cancelTimeoutMs: this.config.cancelTimeoutMs,
      gateCoordinator: this.gateCoordinator,
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

  /** Register gate approval RPC and execution control handlers (start, cancel). */
  private registerExecutionHandlers(): void {
    this.registerHandler(WorkflowSubjects.gate.awaitApproval, async (ctx) => {
      const { action, source } = await this.gateCoordinator.awaitApprovalRequest(ctx.payload);
      ctx.setResult({ action, source });
    });
    this.registerHandler(WorkflowSubjects.start, async (ctx) => {
      const { workflowId, inputs = {}, parentSessionId, triggerPayload, scope } = ctx.payload;
      try {
        const executionId = await this.startExecution(workflowId, {
          inputs,
          parentSessionId,
          triggerPayload,
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
        const executionId = await this.startFileExecution(filePath, {
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
        ctx.setResult({ cancelled: true });
        return;
      }

      const finalizerDeps = this.buildFinalizerDeps();
      const cancelled = await cancelExecution(finalizerDeps, executionId, reason);
      ctx.setResult({ cancelled });
    });
  }

  /**
   * Start a new workflow execution.
   * @param workflowId - The workflow definition ID
   * @param options - Execution options
   * @returns The execution ID
   */
  private async startExecution(
    workflowId: string,
    options: {
      inputs?: Record<string, unknown>;
      parentSessionId?: string;
      triggerPayload?: Record<string, unknown>;
      scopeOverride?: WorkflowExecutionScope;
    } = {},
  ): Promise<string> {
    const { inputs = {}, parentSessionId, triggerPayload, scopeOverride } = options;
    const { workflow } = await this.bus.request(WorkflowStorageSubjects.get, { id: workflowId });
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    validateAuthoredWorkflowSteps(workflow.steps);

    const executionId = generateId('wfx');
    const sanitizedTriggerPayload = sanitizeTriggerPayload(triggerPayload);
    const boundInputs = bindWorkflowInputs(workflow.inputs, inputs);

    // Resolve execution scope: caller override wins; otherwise use the definition's required scope.
    const resolvedScope: WorkflowExecutionScope = scopeOverride ?? workflow.scope;
    const workspaceRoot = await this.resolveExecutionWorkspaceRoot(parentSessionId);

    const { sessionId: coordinatorSessionId } = await this.bus.request(SessionSubjects.create, {
      parentSessionId,
      branchKind: 'coordinator',
      title: `Workflow: ${workflow.name}`,
      targetWorkingDirectory: workspaceRoot,
    });

    const execution: WorkflowExecution = {
      id: executionId,
      workflowId,
      coordinatorSessionId,
      status: 'running',
      inputs: boundInputs,
      steps: buildInitialStepStates(workflow.steps),
      startedAt: Date.now(),
      triggerPayload: sanitizedTriggerPayload,
      scope: resolvedScope,
    };

    let launched = false;
    try {
      await this.bus.request(WorkflowStorageSubjects.setExecution, { execution });

      // Seed stepMap from authored steps (scheduler adds children as for-each nodes expand).
      const stepMap = new Map(workflow.steps.map((step) => [step.id, step]));

      this.activeExecutions.set(executionId, {
        execution,
        workflow,
        stepMap,
        stepContext: new Map(),
      });

      const startedEventTask = this.emitExecutionStarted({ executionId, workflowId, coordinatorSessionId });
      const executionTask =
        this.workflowRunner !== undefined
          ? buildExecutionTask(this.buildRunnerTaskDeps(this.workflowRunner), {
              executionId,
              workflowId,
              workflow,
              coordinatorSessionId,
              sanitizedTriggerPayload: sanitizedTriggerPayload ?? {},
              boundInputs,
              scope: resolvedScope,
              workspaceRoot,
            })
          : this.runExecution(executionId).finally(() => {
              this.executionTasks.delete(executionId);
            });

      this.executionTasks.set(executionId, executionTask);
      launched = true;
      void executionTask;

      await startedEventTask;
      return executionId;
    } catch (error) {
      if (!launched) {
        this.activeExecutions.delete(executionId);
        this.executionTasks.delete(executionId);
        await this.closeCoordinatorSession(coordinatorSessionId);
      }
      throw error;
    }
  }

  /**
   * Start a new workflow execution from a file path on disk.
   *
   * Unlike {@link startExecution}, this variant does not look up the workflow
   * from storage. The ephemeral execution is dispatched directly to the
   * configured {@link IWorkflowRunner} with a `path`-sourced
   * {@link WorkflowWorkerConfig}. The runner loads and validates the file.
   *
   * Only valid when a workflow runner is configured; the caller is responsible
   * for ensuring that precondition before calling this method.
   * @param filePath - Absolute path to the workflow TypeScript or JavaScript file.
   * @param options - Execution options.
   * @returns The execution ID.
   */
  private async startFileExecution(
    filePath: string,
    options: {
      triggerPayload?: Record<string, unknown>;
      scopeOverride?: WorkflowExecutionScope;
    } = {},
  ): Promise<string> {
    const { triggerPayload, scopeOverride } = options;
    const executionId = generateId('wfx');
    const sanitizedTriggerPayload = sanitizeTriggerPayload(triggerPayload);
    const resolvedScope: WorkflowExecutionScope = scopeOverride ?? { type: 'global' };
    const workspaceRoot = this.config.platformDefaults.cwd;

    const { sessionId: coordinatorSessionId } = await this.bus.request(SessionSubjects.create, {
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
      await this.bus.request(WorkflowStorageSubjects.setExecution, { execution });

      // The runner manages the full execution lifecycle (step events, completion).
      // Register a minimal ActiveExecution entry so cancellation and shutdown
      // can abort the runner via workflowAbortControllers.
      this.activeExecutions.set(executionId, {
        execution,
        workflow: {
          id: workflowId,
          name: filePath,
          scope: resolvedScope,
          steps: [],
          createdAt: 0,
          updatedAt: 0,
        },
        stepMap: new Map(),
        stepContext: new Map(),
      });

      const startedEventTask = this.emitExecutionStarted({ executionId, workflowId, coordinatorSessionId });
      // workflowRunner presence is enforced by the runFile handler before
      // startFileExecution is called — this guard is a defensive belt-and-suspenders
      // check that also satisfies the type narrowing without a non-null assertion.
      const { workflowRunner } = this;
      if (workflowRunner === undefined) {
        throw new Error('[WorkflowExecutor] startFileExecution called without a workflow runner');
      }
      const executionTask = buildFileExecutionTask(this.buildRunnerTaskDeps(workflowRunner), {
        executionId,
        workflowId,
        filePath,
        coordinatorSessionId,
        sanitizedTriggerPayload: sanitizedTriggerPayload ?? {},
        scope: resolvedScope,
        workspaceRoot,
      });

      this.executionTasks.set(executionId, executionTask);
      launched = true;
      void executionTask;

      await startedEventTask;
      return executionId;
    } catch (error) {
      if (!launched) {
        this.activeExecutions.delete(executionId);
        this.executionTasks.delete(executionId);
        await this.closeCoordinatorSession(coordinatorSessionId);
      }
      throw error;
    }
  }

  /**
   * Emit the execution-started lifecycle event without letting observer failures
   * prevent an already-persisted execution from running.
   * @param payload - Execution lifecycle payload.
   */
  private async emitExecutionStarted(payload: {
    executionId: string;
    workflowId: string;
    coordinatorSessionId: string;
  }): Promise<void> {
    try {
      await this.bus.emit(WorkflowSubjects.execution.started, payload);
    } catch (error) {
      console.error('[WorkflowExecutor] execution.started listener failed:', error);
    }
  }

  /**
   * Close a coordinator session created for an execution that failed before launch.
   * @param sessionId - Coordinator session ID.
   */
  private async closeCoordinatorSession(sessionId: string): Promise<void> {
    await this.bus.request(SessionSubjects.close, { sessionId }).catch((error: unknown) => {
      console.error(
        `[WorkflowExecutor] Failed to close coordinator session "${sessionId}" after launch failure:`,
        error,
      );
    });
  }

  /**
   * Main execution loop — delegates to the mutable DAG scheduler.
   *
   * The scheduler finds ready nodes at each tick, expands composite for-each
   * nodes on-demand, and runs executable nodes via the step runner.
   * @param executionId - The execution ID
   */
  private async runExecution(executionId: string): Promise<void> {
    const active = this.activeExecutions.get(executionId);
    if (!active) return;

    const stepRunner = this.stepRunner;
    const scheduler = new WorkflowScheduler(
      {
        bus: this.bus,
        activeExecutions: this.activeExecutions,
        shellAbortControllers: this.shellAbortControllers,
        activeRunnerSteps: this.activeRunnerSteps,
        gateCoordinator: this.gateCoordinator,
        runStep: (config, signal) => stepRunner.run(config, signal),
        forceKillStep: stepRunner.forceKill ? (execId, stepId) => stepRunner.forceKill!(execId, stepId) : undefined,
        runnerManagesLifecycle: stepRunner.managesWorkflowLifecycle,
        onAbortSubagent: async (_nodeId, subagentId) => {
          await this.bus.request(SubagentSubjects.kill, { subagentId, reason: 'Workflow step failed' });
        },
        config: this.config,
      },
      executionId,
    );

    await scheduler.run(active.workflow.steps);
  }
}
