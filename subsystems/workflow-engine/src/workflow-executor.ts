import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type IWorkflowTriggerTypeRegistry, type WorkflowExecution } from '@makaio/contracts';
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
import {
  buildExpressionContext,
  executeAgentStep,
  executeShellStep,
  executeGateStep,
} from './workflow-step-executors.js';

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
export class WorkflowExecutor {
  /** Drizzle storage handler registration for the composition root. */
  public static readonly storage = {
    drizzle: registerDrizzleWorkflowStorage,
  } as const;
  private readonly bus: IMakaioBus;
  private readonly config: ExecutorConfig;
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private readonly shellAbortControllers = new Map<string, AbortController>();
  private readonly gateCoordinator: WorkflowGateCoordinator;
  private readonly cleanupFns: Array<() => void> = [];
  private initialized = false;
  private triggerTypeRegistry?: IWorkflowTriggerTypeRegistry;

  /**
   * Create a new workflow executor.
   * @param bus - The message bus for communication
   * @param config - Optional partial configuration (merged with defaults)
   */
  public constructor(bus: IMakaioBus, config?: Partial<ExecutorConfig>) {
    this.bus = bus;
    this.config = { ...DEFAULT_EXECUTOR_CONFIG, ...config };
    this.gateCoordinator = new WorkflowGateCoordinator(bus);
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
   * Initialize the executor and register bus handlers.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;

    this.registerExecutionHandlers();
    this.cleanupFns.push(...registerWorkflowStorageDelegationHandlers(this.bus));
    this.cleanupFns.push(...registerWorkflowTriggerTypeHandlers(this.bus, () => this.triggerTypeRegistry));
    this.gateCoordinator.registerResponseHandler(this.cleanupFns);

    this.initialized = true;
  }

  /** Register execution control handlers (start, cancel). */
  private registerExecutionHandlers(): void {
    this.cleanupFns.push(
      this.bus.on(WorkflowSubjects.start, async (ctx) => {
        const { workflowId, inputs = {}, parentSessionId, triggerPayload } = ctx.payload;
        try {
          const executionId = await this.startExecution(workflowId, inputs, parentSessionId, triggerPayload);
          ctx.setResult({ executionId });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to start workflow: ${message}`);
        }
      }),
    );

    this.cleanupFns.push(
      this.bus.on(WorkflowSubjects.cancel, async (ctx) => {
        const { executionId } = ctx.payload;
        const success = await cancelExecution(
          this.bus,
          this.activeExecutions,
          this.shellAbortControllers,
          this.gateCoordinator,
          executionId,
        );
        ctx.setResult({ success });
      }),
    );
  }

  /**
   * Destroy the executor and cleanup resources.
   */
  public destroy(): void {
    if (!this.initialized) return;
    this.initialized = false;
    this.gateCoordinator.dispose();
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns.length = 0;
    // Do not issue async bus requests during destroy; callers may tear down
    // storage/session handlers immediately after this returns.
    this.activeExecutions.clear();
    for (const controller of this.shellAbortControllers.values()) {
      controller.abort();
    }
    this.shellAbortControllers.clear();
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

    // Expand for-each steps into the flat DAG before building execution state
    const initialContext = {
      trigger: sanitizedTriggerPayload ?? {},
      steps: {},
      inputs,
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
      inputs,
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
    await this.bus.emit(WorkflowSubjects.started, { executionId, workflowId, coordinatorSessionId });
    void this.runExecution(executionId);
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

        const stepResults = await Promise.allSettled(level.map((stepId) => this.executeStep(executionId, stepId)));

        if (execution.status !== 'running') return;

        const rejectedResult = stepResults.find((result) => result.status === 'rejected');
        if (rejectedResult?.status === 'rejected') {
          const message =
            rejectedResult.reason instanceof Error ? rejectedResult.reason.message : String(rejectedResult.reason);
          await completeExecutionWithFailure(this.bus, this.activeExecutions, execution, executionId, message);
          return;
        }

        const failedStepId = level.find((id) => execution.steps[id]?.status === 'failed');
        if (failedStepId) {
          await completeExecutionWithFailure(
            this.bus,
            this.activeExecutions,
            execution,
            executionId,
            execution.steps[failedStepId]?.error ?? 'Step failed',
            failedStepId,
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
   * Execute a single workflow step, dispatching to the appropriate handler by step type.
   * @param executionId - The execution ID
   * @param stepId - The step ID to execute
   * @returns Resolves when the step has completed or failed
   */
  private async executeStep(executionId: string, stepId: string): Promise<void> {
    const active = this.activeExecutions.get(executionId);
    if (!active) return;

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
        await this.bus.emit(WorkflowSubjects.stepSkipped, {
          executionId,
          stepId,
          condition: step.if,
        });
        return;
      }
    }

    const deps = {
      bus: this.bus,
      activeExecutions: this.activeExecutions,
      shellAbortControllers: this.shellAbortControllers,
      gateCoordinator: this.gateCoordinator,
      config: this.config,
    };

    switch (step.type) {
      case 'agent':
        return executeAgentStep(deps, executionId, stepId);
      case 'shell':
        return executeShellStep(deps, executionId, stepId);
      case 'gate':
        return executeGateStep(deps, executionId, stepId);
      case 'for-each':
        throw new Error(`for-each step '${stepId}' should have been expanded before execution`);
    }
  }
}
