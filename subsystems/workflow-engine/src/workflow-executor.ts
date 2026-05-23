import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  SubagentSubjects,
  type IStepRunner,
  type IWorkflowTriggerTypeRegistry,
  type WorkflowDefinition,
  type WorkflowExecution,
} from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { evaluateSync } from '@makaio/expression';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import { registerDrizzleWorkflowStorage } from './storage/handler.js';
import { groupByTopoLevel } from './dag-utils.js';
import { DEFAULT_EXECUTOR_CONFIG, type ExecutorConfig, type ActiveExecution } from './types.js';
import { generateId, sleep } from './executor-helpers.js';
import { expandForEachSteps } from './for-each-expander.js';
import { sanitizeTriggerPayload } from './trigger-payload-sanitizer.js';
import {
  registerWorkflowStorageDelegationHandlers,
  registerWorkflowTriggerTypeHandlers,
} from './workflow-executor-handlers.js';
import {
  completeExecutionWithFailure,
  completeExecutionWithSuccess,
  cancelExecution,
} from './workflow-execution-finalizer.js';
import { WorkflowGateCoordinator } from './workflow-gate-coordinator.js';
import { buildExpressionContext } from './workflow-step-executors.js';
import { InProcessStepRunner } from './in-process-step-runner.js';
import {
  applyStepRunResult,
  persistStepSpan,
  prepareRunnerManagedStep,
  runnerManagesWorkflowLifecycle,
  type FailedStepExecutionOutcome,
  type StepExecutionOutcome,
} from './workflow-step-result.js';

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
 * - Executes steps in topological order
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
    await Promise.allSettled(
      [...this.activeExecutions.keys()].map((executionId) =>
        cancelExecution(
          this.bus,
          this.activeExecutions,
          this.shellAbortControllers,
          this.gateCoordinator,
          executionId,
          'Workflow engine shutdown',
        ),
      ),
    );
    this.gateCoordinator.dispose();
    for (const controller of this.shellAbortControllers.values()) {
      controller.abort();
    }
    this.shellAbortControllers.clear();
    await Promise.allSettled(this.executionTasks.values());
    await this.stepRunner.dispose?.();
    this.activeExecutions.clear();
  }

  /** Register execution control handlers (start, cancel). */
  private registerExecutionHandlers(): void {
    this.registerHandler(WorkflowSubjects.start, async (ctx) => {
      const { workflowId, inputs = {}, parentSessionId, triggerPayload } = ctx.payload;
      try {
        const executionId = await this.startExecution(workflowId, inputs, parentSessionId, triggerPayload);
        ctx.setResult({ executionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to start workflow: ${message}`);
      }
    });

    this.registerHandler(WorkflowSubjects.cancel, async (ctx) => {
      const { executionId, reason } = ctx.payload;
      const cancelled = await cancelExecution(
        this.bus,
        this.activeExecutions,
        this.shellAbortControllers,
        this.gateCoordinator,
        executionId,
        reason,
      );
      ctx.setResult({ cancelled });
    });
  }

  /**
   * Start a new workflow execution.
   * @param workflowId - The workflow definition ID
   * @param inputs - Input values for the workflow
   * @param parentSessionId - Optional parent session ID
   * @param triggerPayload - Optional payload from the firing trigger
   * @returns The execution ID
   */
  private async startExecution(
    workflowId: string,
    inputs: Record<string, unknown>,
    parentSessionId?: string,
    triggerPayload?: Record<string, unknown>,
  ): Promise<string> {
    const { workflow } = await this.bus.request(WorkflowStorageSubjects.get, { id: workflowId });
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const executionId = generateId('wfx');
    const sanitizedTriggerPayload = sanitizeTriggerPayload(triggerPayload);
    const boundInputs = bindWorkflowInputs(workflow.inputs, inputs);

    // Expand for-each steps into the flat DAG before building execution state
    const initialContext = {
      trigger: sanitizedTriggerPayload ?? {},
      steps: {},
      inputs: boundInputs,
    };
    const { steps: expandedSteps, stepContext } = expandForEachSteps(workflow.steps, initialContext);
    const { sessionId: coordinatorSessionId } = await this.bus.request(SessionSubjects.create, {
      parentSessionId,
      branchKind: 'coordinator',
      title: `Workflow: ${workflow.name}`,
    });

    const steps: WorkflowExecution['steps'] = {};
    for (const step of expandedSteps) {
      steps[step.id] = { status: 'pending' };
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
    };

    await this.bus.request(WorkflowStorageSubjects.setExecution, { execution });
    this.activeExecutions.set(executionId, {
      execution,
      workflow,
      expandedSteps,
      stepMap: new Map(expandedSteps.map((step) => [step.id, step])),
      stepContext,
    });
    await this.bus.emit(WorkflowSubjects.execution.started, { executionId, workflowId, coordinatorSessionId });
    const executionTask = this.runExecution(executionId).finally(() => {
      this.executionTasks.delete(executionId);
    });
    this.executionTasks.set(executionId, executionTask);
    void executionTask;
    return executionId;
  }

  /**
   * Main execution loop - executes steps in parallel topological levels.
   * All steps within a level are started concurrently; the next level begins
   * only after every step in the current level has settled.
   * @param executionId - The execution ID
   */
  private async runExecution(executionId: string): Promise<void> {
    const active = this.activeExecutions.get(executionId);
    if (!active) return;

    const { execution, expandedSteps } = active;
    const startTime = Date.now();

    try {
      const levels = groupByTopoLevel(expandedSteps);

      for (const level of levels) {
        if (execution.status !== 'running') return;

        const failedOutcome = await this.runTopoLevel(executionId, level);
        if (execution.status !== 'running') return;

        if (failedOutcome) {
          await completeExecutionWithFailure(
            this.bus,
            this.activeExecutions,
            execution,
            executionId,
            failedOutcome.error,
            failedOutcome.failedStepId,
          );
          await this.releaseLevelResources(
            executionId,
            execution,
            level.filter((stepId) => stepId !== failedOutcome.stepId),
          );
          return;
        }

        if (this.config.stepCooldownMs > 0) {
          await sleep(this.config.stepCooldownMs);
        }
      }

      await completeExecutionWithSuccess(this.bus, this.activeExecutions, execution, executionId, startTime);
    } catch (error) {
      if (execution.status !== 'running') return;
      const message = error instanceof Error ? error.message : String(error);
      await completeExecutionWithFailure(this.bus, this.activeExecutions, execution, executionId, message);
    }
  }

  /**
   * Run one topological level concurrently, returning as soon as any step fails.
   * @param executionId - The execution ID.
   * @param level - Step IDs in the current topological level.
   * @returns First failed step outcome, or undefined when all steps complete or skip.
   */
  private async runTopoLevel(executionId: string, level: string[]): Promise<FailedStepExecutionOutcome | undefined> {
    const pending = new Map<string, Promise<StepExecutionOutcome & { stepId: string }>>();

    for (const stepId of level) {
      pending.set(
        stepId,
        this.executeStep(executionId, stepId)
          .then((outcome) => ({ ...outcome, stepId }))
          .catch((error: unknown) => ({
            stepId,
            status: 'failed' as const,
            error: error instanceof Error ? error.message : String(error),
            failedStepId: stepId,
          })),
      );
    }

    while (pending.size > 0) {
      const outcome = await Promise.race(pending.values());
      pending.delete(outcome.stepId);
      if (outcome.status === 'failed') return outcome;
    }

    return undefined;
  }

  private async releaseLevelResources(
    executionId: string,
    execution: WorkflowExecution,
    stepIds: string[],
  ): Promise<void> {
    execution.status = 'failed';
    await Promise.all(
      stepIds.map(async (stepId) => {
        this.gateCoordinator.resolveForCancellation(executionId, stepId);
        this.shellAbortControllers.get(`${executionId}:${stepId}`)?.abort();
        const subagentId = execution.steps[stepId]?.subagentId;
        if (subagentId) {
          await this.bus.request(SubagentSubjects.kill, { subagentId, reason: 'Workflow step failed' }).catch(() => {});
        }
      }),
    );
  }

  private async executeStep(executionId: string, stepId: string): Promise<StepExecutionOutcome> {
    const active = this.activeExecutions.get(executionId);
    if (!active) return { status: 'failed', error: 'Execution no longer active', failedStepId: stepId };

    const step = active.stepMap.get(stepId);
    if (!step) throw new Error(`Step not found: ${stepId}`);

    if (step.if) {
      const context = buildExpressionContext(active.execution, this.activeExecutions, stepId);
      const result = evaluateSync(step.if, context);
      if (!result) {
        const stepState = active.execution.steps[stepId];
        stepState.status = 'skipped';
        stepState.completedAt = Date.now();
        await this.bus.request(WorkflowStorageSubjects.setExecution, { execution: active.execution });
        await persistStepSpan(this.bus, active, stepId, 'skipped');
        await this.bus.emit(WorkflowSubjects.step.skipped, {
          executionId,
          stepId,
          stepType: step.type as 'agent' | 'shell' | 'gate',
          condition: step.if,
        });
        return { status: 'skipped' };
      }
    }

    if (step.type === 'for-each') {
      throw new Error(`for-each step '${stepId}' should have been expanded before execution`);
    }

    const resolvedInputs: Record<string, unknown> = {
      ...buildExpressionContext(active.execution, this.activeExecutions, stepId),
    };
    const stepRunnerManagesLifecycle = runnerManagesWorkflowLifecycle(this.stepRunner);
    if (!stepRunnerManagesLifecycle) {
      await prepareRunnerManagedStep(this.bus, active, stepId);
      if (active.execution.status !== 'running') {
        return { status: 'failed', error: 'Execution cancelled', failedStepId: stepId };
      }
    }

    const result = await this.stepRunner.run({
      executionId,
      workflowId: active.workflow.id,
      stepId,
      stepType: step.type,
      stepDefinition: step,
      resolvedInputs,
    });

    return applyStepRunResult(this.bus, active, stepId, result, resolvedInputs);
  }
}
