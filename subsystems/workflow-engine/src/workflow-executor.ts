import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  type IStepRunner,
  type IWorkflowTriggerTypeRegistry,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowExecutionScope,
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
import { validateAuthoredWorkflowSteps } from './dag-utils.js';

/**
 * Merge provided inputs with workflow input definitions, applying defaults and
 * throwing for missing required inputs.
 * @param definitions - Workflow input parameter definitions
 * @param provided - Caller-supplied input values
 * @returns Bound input record with defaults applied
 */
function bindWorkflowInputs(
  definitions: WorkflowDefinition['inputs'] | undefined,
  provided: Record<string, unknown>,
): Record<string, unknown> {
  const bound: Record<string, unknown> = {};

  for (const input of definitions ?? []) {
    if (Object.prototype.hasOwnProperty.call(provided, input.name)) {
      bound[input.name] = provided[input.name];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'default')) {
      bound[input.name] = input.default;
      continue;
    }
    if (input.required) {
      throw new Error(`Missing required workflow input: ${input.name}`);
    }
  }

  for (const [key, value] of Object.entries(provided)) {
    if (!Object.prototype.hasOwnProperty.call(bound, key)) {
      bound[key] = value;
    }
  }

  return bound;
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
  private readonly gateCoordinator: WorkflowGateCoordinator;
  private readonly stepRunner: IStepRunner;
  private triggerTypeRegistry?: IWorkflowTriggerTypeRegistry;

  /**
   * Create a new workflow executor.
   * @param bus - The message bus for communication
   * @param config - Optional partial configuration (merged with defaults)
   * @param stepRunner - Optional step runner override (defaults to InProcessStepRunner)
   */
  public constructor(bus: IMakaioBus, config?: Partial<ExecutorConfig>, stepRunner?: IStepRunner) {
    super(bus);
    this.config = { ...DEFAULT_EXECUTOR_CONFIG, ...config };
    this.gateCoordinator = new WorkflowGateCoordinator(bus);
    this.stepRunner =
      stepRunner ??
      new InProcessStepRunner({
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
    const finalizerDeps: FinalizerDeps = {
      bus: this.bus,
      activeExecutions: this.activeExecutions,
      shellAbortControllers: this.shellAbortControllers,
      activeRunnerSteps: this.activeRunnerSteps,
      stepRunner: this.stepRunner,
      cancelTimeoutMs: this.config.cancelTimeoutMs,
      gateCoordinator: this.gateCoordinator,
    };
    // 1. Cancel all active executions (aborts controllers, schedules hard-kill timers).
    await Promise.allSettled(
      [...this.activeExecutions.keys()].map((executionId) =>
        cancelExecution(finalizerDeps, executionId, 'Workflow engine shutdown'),
      ),
    );
    this.gateCoordinator.dispose();
    // 2. Await all execution tasks to settle (runners terminate via abort or forceKill).
    await Promise.allSettled(this.executionTasks.values());
    // 3. Clean up remaining timers and maps after all tasks have settled.
    for (const controller of this.shellAbortControllers.values()) {
      controller.abort();
    }
    this.shellAbortControllers.clear();
    for (const entry of this.activeRunnerSteps.values()) {
      if (entry.hardKillTimer) clearTimeout(entry.hardKillTimer);
    }
    this.activeRunnerSteps.clear();
    await this.stepRunner.dispose?.();
    this.activeExecutions.clear();
  }

  /** Register execution control handlers (start, cancel). */
  private registerExecutionHandlers(): void {
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

    this.registerHandler(WorkflowSubjects.cancel, async (ctx) => {
      const { executionId, reason } = ctx.payload;
      const finalizerDeps: FinalizerDeps = {
        bus: this.bus,
        activeExecutions: this.activeExecutions,
        shellAbortControllers: this.shellAbortControllers,
        activeRunnerSteps: this.activeRunnerSteps,
        stepRunner: this.stepRunner,
        cancelTimeoutMs: this.config.cancelTimeoutMs,
        gateCoordinator: this.gateCoordinator,
      };
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

    const { sessionId: coordinatorSessionId } = await this.bus.request(SessionSubjects.create, {
      parentSessionId,
      branchKind: 'coordinator',
      title: `Workflow: ${workflow.name}`,
    });

    // Initialize step states from authored steps.
    // For-each steps get composite state; all others get executable state.
    const steps: WorkflowExecution['steps'] = {};
    for (const step of workflow.steps) {
      steps[step.id] =
        step.type === 'for-each' ? { kind: 'composite', status: 'pending' } : { kind: 'executable', status: 'pending' };
    }

    const execution: WorkflowExecution = {
      id: executionId,
      workflowId,
      coordinatorSessionId,
      status: 'running',
      inputs: boundInputs,
      steps,
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
      const executionTask = Promise.resolve()
        .then(() => this.runExecution(executionId))
        .finally(() => {
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

    const scheduler = new WorkflowScheduler(
      {
        bus: this.bus,
        activeExecutions: this.activeExecutions,
        shellAbortControllers: this.shellAbortControllers,
        activeRunnerSteps: this.activeRunnerSteps,
        gateCoordinator: this.gateCoordinator,
        stepRunner: this.stepRunner,
        config: this.config,
      },
      executionId,
    );

    await scheduler.run(active.workflow.steps);
  }
}
