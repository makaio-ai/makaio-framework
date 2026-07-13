/* eslint max-lines: ["error", { "max": 600, "skipBlankLines": true, "skipComments": true }], max-lines-per-function: ["error", { "max": 130, "skipBlankLines": true, "skipComments": true }] */
import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  WORKFLOW_CANCELLED_REASON,
  WorkflowError,
  createWorkflowCancelSubject,
  type IWorkflowRunner,
  type IWorkflowTriggerTypeRegistry,
  type JsonValue,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowRunResult,
  createWorkflowFinalizerNamespace,
} from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import { registerDrizzleWorkflowStorage } from './storage/handler.js';
import { DEFAULT_EXECUTOR_CONFIG, type ActiveRunnerStep, type ExecutorConfig, type ActiveExecution } from './types.js';
import {
  registerWorkflowStorageDelegationHandlers,
  registerWorkflowStateHandlers,
  registerWorkflowTriggerTypeHandlers,
} from './workflow-executor-handlers.js';
import {
  cancelExecution,
  completeExecutionWithFailure,
  completeExecutionWithSuccess,
  isAcceptedRunnerResultStatus,
  recoverSuccessFinalizations,
  type FinalizerDeps,
  type WorkflowSuccessFinalizer,
} from './workflow-execution-finalizer.js';
import {
  buildDefinitionRunnerParamsFromRunContext,
  finalizeResolvedRunnerResult,
  type RunnerTaskDeps,
} from './workflow-runner-tasks.js';
import { startExecution, startFileExecution, type StartExecutionDeps } from './workflow-execution-start.js';
import { rerunExecution } from './workflow-execution-rerun.js';
import { launchDefinitionExecutionTask } from './workflow-definition-dispatch.js';
import { RuntimeContext } from './runtime/runtime-context.js';
import { executeSequence } from './runtime/primitive-runtime.js';
import { assertLoopGateHandlersPresent } from './runtime/loop-gate-handlers.js';
import type { NodeOutcome } from './runtime/node-execution.js';
import { resolveWorkflowArtifactBinding } from './artifact-context/artifact-binding.js';
import { validateGateResumeDataForSchema } from './runtime/gate-resume-validation.js';
import { WorkflowGateTimeoutScheduler } from './workflow-gate-timeout-scheduler.js';
import {
  normalizeConfig,
  normalizeExecutionHints,
  normalizeStartInput,
} from './workflow-executor-input-normalization.js';
import { buildWorkflowRunContext, resolveWorkflowContext } from './workflow-run-context-builder.js';
import {
  assertDurableResumeFramesPresent,
  isPausedWorkflowExecution,
  loadUniqueWaitingGateInstance,
  restorePausedGateAfterResumeFailure,
  toGateTimeoutPayload,
} from './workflow-resume-state.js';
import { registerAuthorityStateBootstrapHandler } from './authority-state-bootstrap.js';

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
  public static readonly storage = { drizzle: registerDrizzleWorkflowStorage } as const;

  private readonly config: ExecutorConfig;
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private readonly executionTasks = new Map<string, Promise<void>>();
  private readonly shellAbortControllers = new Map<string, AbortController>();
  private readonly activeRunnerSteps = new Map<string, ActiveRunnerStep>();
  private readonly gateTimeoutScheduler: WorkflowGateTimeoutScheduler;
  private readonly resumeDispatches = new Set<string>();
  /**
   * Per-execution abort controllers used to cancel workflow-level runners.
   * Keyed by execution ID; only populated when a {@link IWorkflowRunner} is used.
   */
  private readonly workflowAbortControllers = new Map<string, AbortController>();
  private readonly successFinalizers = new Map<string, WorkflowSuccessFinalizer>();
  private readonly durableLifecycleTransitions = new Map<string, Promise<void>>();
  private readonly lifecyclePublications = new Map<string, Promise<void>>();
  private readonly publishingLifecycleExecutions = new Set<string>();
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
    this.gateTimeoutScheduler = new WorkflowGateTimeoutScheduler(bus, (executionId) =>
      this.resumePausedExecution(executionId),
    );
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
   * Register one named finalizer eligible for compiled workflow success transitions.
   *
   * A workflow selects this registration through its immutable
   * `successFinalizerId` definition field. Disposing the returned registration
   * leaves already-claimed work recoverable only when the same ID is registered
   * again on a later executor instance.
   * @param finalizerId - Stable finalizer identity used by the durable claim.
   * @returns Idempotent cleanup after any recoverable claims have been drained.
   * @throws When another active registration already owns `finalizerId`.
   */
  public async registerSuccessFinalizer(finalizerId: string): Promise<() => void> {
    if (!this.initialized) {
      throw new Error('[WorkflowExecutor] Initialize the executor before registering success finalizers');
    }
    if (this.successFinalizers.has(finalizerId)) {
      throw new Error(`[WorkflowExecutor] Success finalizer already registered: ${finalizerId}`);
    }
    const { namespace, subjects } = createWorkflowFinalizerNamespace(finalizerId);
    this.bus.registerNamespace(namespace);
    const registration: WorkflowSuccessFinalizer = { finalizerId, finalizeSubject: subjects.finalize };
    this.successFinalizers.set(finalizerId, registration);
    try {
      await recoverSuccessFinalizations(this.buildFinalizerDeps());
    } catch (error) {
      if (this.successFinalizers.get(finalizerId) === registration) this.successFinalizers.delete(finalizerId);
      throw error;
    }

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.successFinalizers.get(finalizerId) === registration) {
        this.successFinalizers.delete(finalizerId);
      }
    };
  }

  /**
   * Accept a terminal result from an authority-dispatched runner that was not
   * launched through this executor's in-memory task registry.
   *
   * Durable execution and run-context rows remain the source of truth. The
   * executor temporarily adopts a missing active entry and delegates to the
   * same runner-result finalization path used by executor-owned tasks.
   * @param executionId - Durable authority-owned execution identity.
   * @param result - Correlated terminal runner result.
   * @returns The durable status after acceptance, including pending success finalization.
   */
  public async acceptAuthorityRunnerResult(
    executionId: string,
    result: WorkflowRunResult,
  ): Promise<{ accepted: boolean; status: WorkflowExecution['status'] }> {
    if (result.status === 'paused') throw new Error('authority runner result must be terminal');
    if (result.executionId !== executionId) throw new Error('authority runner result execution identity mismatch');
    const { execution } = await this.bus.request(WorkflowStorageSubjects.getExecution, { executionId });
    if (!execution) throw new Error(`Authority runner execution not found: ${executionId}`);
    if (execution.workflowId !== result.workflowId)
      throw new Error('authority runner result workflow identity mismatch');

    let replayCleanup: (() => void) | undefined;
    if (execution.status === 'finalizing') {
      const { workflow } = await this.loadAuthorityRunnerContext(executionId, result.workflowId);
      replayCleanup = await this.registerAuthorityResultFinalizer(workflow);
    }
    const replayStatus = await this.resolveAuthorityRunnerReplay(execution, result).finally(() => replayCleanup?.());
    if (replayStatus !== undefined) return { accepted: true, status: replayStatus };
    if (execution.status !== 'running') throw new Error(`Authority runner execution is ${execution.status}`);

    const { runContext, workflow } = await this.loadAuthorityRunnerContext(executionId, result.workflowId);
    const unregisterFinalizer = await this.registerAuthorityResultFinalizer(workflow);

    const existing = this.activeExecutions.get(executionId);
    let adopted = false;
    if (!existing) {
      this.activeExecutions.set(executionId, {
        execution,
        workflow,
        runContext,
        runtimeHandlers: new Map(),
        runtimeLoopGates: new Map(),
      });
      adopted = true;
    } else if (existing.execution.workflowId !== result.workflowId) {
      throw new Error('authority runner active execution identity mismatch');
    }
    try {
      await finalizeResolvedRunnerResult(
        {
          activeExecutions: this.activeExecutions,
          buildFinalizerDeps: () => this.buildFinalizerDeps(),
        },
        result,
      );
    } finally {
      if (adopted) this.activeExecutions.delete(executionId);
      unregisterFinalizer?.();
    }
    const settled = await this.bus.request(WorkflowStorageSubjects.getExecution, { executionId });
    if (!settled.execution || !isAcceptedRunnerResultStatus(settled.execution.status, result.status)) {
      throw new Error(`Authority runner result did not settle compatibly with ${result.status}`);
    }
    return { accepted: true, status: settled.execution.status };
  }

  private async resolveAuthorityRunnerReplay(
    execution: WorkflowExecution,
    result: WorkflowRunResult,
  ): Promise<WorkflowExecution['status'] | undefined> {
    if (execution.status === 'finalizing') {
      if (result.status !== 'completed') {
        throw new Error('authority runner result conflicts with terminal execution');
      }
      await recoverSuccessFinalizations(this.buildFinalizerDeps());
      const replayed = await this.bus.request(WorkflowStorageSubjects.getExecution, { executionId: execution.id });
      if (!replayed.execution) throw new Error('Authority runner success finalization execution is missing');
      if (!isAcceptedRunnerResultStatus(replayed.execution.status, result.status)) {
        throw new Error('authority runner result conflicts with terminal execution');
      }
      return replayed.execution.status;
    }
    if (execution.status !== 'completed' && execution.status !== 'failed' && execution.status !== 'cancelled') {
      return undefined;
    }
    if (!isAcceptedRunnerResultStatus(execution.status, result.status))
      throw new Error('authority runner result conflicts with terminal execution');
    return execution.status;
  }

  private async loadAuthorityRunnerContext(executionId: string, workflowId: string) {
    const { runContext } = await this.bus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    if (!runContext) throw new Error(`Authority runner run context not found: ${executionId}`);
    if (runContext.executionId !== executionId || runContext.workflowId !== workflowId) {
      throw new Error('authority runner run context identity mismatch');
    }
    if (runContext.terminalAuthority !== 'authority') {
      throw new Error('authority runner result requires terminalAuthority=authority');
    }
    const workflow =
      runContext.definitionSnapshot ??
      (await this.bus.request(WorkflowStorageSubjects.get, { id: runContext.workflowId })).workflow;
    if (!workflow || workflow.id !== workflowId) {
      throw new Error('authority runner workflow definition is unavailable or mismatched');
    }
    return { runContext, workflow };
  }

  private registerAuthorityResultFinalizer(workflow: WorkflowDefinition): Promise<(() => void) | undefined> {
    if (!workflow.successFinalizerId || this.successFinalizers.has(workflow.successFinalizerId)) {
      return Promise.resolve(undefined);
    }
    return this.registerSuccessFinalizer(workflow.successFinalizerId);
  }

  /**
   * Register all bus handlers via BaseService lifecycle.
   * Called once by `init()` — idempotency is handled by BaseService.
   */
  protected async onInit(): Promise<void> {
    this.registerExecutionHandlers();
    this.addCleanup(
      registerAuthorityStateBootstrapHandler(this.bus, (executionId, definition) => {
        const active = this.activeExecutions.get(executionId);
        if (active !== undefined) active.workflow = definition;
      }),
    );
    for (const cleanup of registerWorkflowStorageDelegationHandlers(this.bus)) {
      this.addCleanup(cleanup);
    }
    for (const cleanup of registerWorkflowStateHandlers(this.bus)) {
      this.addCleanup(cleanup);
    }
    for (const cleanup of registerWorkflowTriggerTypeHandlers(this.bus, () => this.triggerTypeRegistry)) {
      this.addCleanup(cleanup);
    }
    await this.rehydratePausedGateTimeouts();
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
    await Promise.allSettled(this.durableLifecycleTransitions.values());
    await Promise.allSettled(this.lifecyclePublications.values());
    // 4. Clean up remaining timers and maps after all tasks have settled.
    for (const controller of this.shellAbortControllers.values()) {
      controller.abort();
    }
    this.shellAbortControllers.clear();
    for (const entry of this.activeRunnerSteps.values()) {
      if (entry.hardKillTimer) clearTimeout(entry.hardKillTimer);
    }
    this.activeRunnerSteps.clear();
    this.gateTimeoutScheduler.dispose();
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
      successFinalizers: this.successFinalizers,
      resolveSuccessFinalizerId: (executionId) => this.activeExecutions.get(executionId)?.workflow.successFinalizerId,
      durableLifecycleTransitions: this.durableLifecycleTransitions,
      lifecyclePublications: this.lifecyclePublications,
      publishingLifecycleExecutions: this.publishingLifecycleExecutions,
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
      resolveWorkflowContext: (workspaceRoot) => resolveWorkflowContext(this.config, workspaceRoot),
      config: this.config,
    };
  }

  /**
   * Resolve the workspace root inherited from a parent session.
   *
   * Coordinator sessions are created with this target working directory so
   * in-process shell steps and workflow-level workers share the same workspace.
   *
   * Throws when a `parentSessionId` is supplied but the session does not exist.
   * The session create handler enforces the same invariant, but throwing here
   * provides a cleaner error before any coordinator session is created.
   * @param parentSessionId - Optional parent session identifier.
   * @returns Parent session working directory, or the executor default cwd.
   * @throws When `parentSessionId` is provided but the session is not found.
   */
  private async resolveExecutionWorkspaceRoot(parentSessionId?: string): Promise<string> {
    if (!parentSessionId) {
      return this.config.platformDefaults.cwd;
    }

    const { session } = await this.bus.request(SessionSubjects.get, { sessionId: parentSessionId });
    if (session === null) {
      throw new Error(`[WorkflowExecutor] Parent session not found: ${parentSessionId}`);
    }
    return session.targetWorkingDirectory ?? this.config.platformDefaults.cwd;
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
      buildRunContext: (params) => buildWorkflowRunContext(params, this.config),
      buildRunnerTaskDeps: (runner) => this.buildRunnerTaskDeps(runner),
      buildFinalizerDeps: () => this.buildFinalizerDeps(),
      resolveExecutionWorkspaceRoot: (parentSessionId) => this.resolveExecutionWorkspaceRoot(parentSessionId),
      runExecution: (executionId) => this.runExecution(executionId),
    };
  }

  /** Register execution control handlers (start, cancel). */
  private registerExecutionHandlers(): void {
    this.registerHandler(WorkflowSubjects.acceptAuthorityRunnerResult, async (ctx) => {
      if (!ctx.origin.local) throw new Error('authority runner result acceptance is local-authority only');
      const { executionId, result } = ctx.payload;
      // Runtime parsing has already established the worker-result contract.
      // Its inferred artifact shape is wider than the hand-authored interface.
      ctx.setResult(await this.acceptAuthorityRunnerResult(executionId, result as WorkflowRunResult));
    });
    this.registerHandler(WorkflowSubjects.start, async (ctx) => {
      const { workflowId, input, config, parentSessionId, triggerPayload, artifactRef, scope, executionHints } =
        ctx.payload;
      try {
        const executionId = await startExecution(this.buildStartDeps(), workflowId, {
          input: normalizeStartInput(input),
          config: normalizeConfig(config) ?? {},
          parentSessionId,
          triggerPayload,
          artifactRef,
          executionHints: normalizeExecutionHints(executionHints),
          scopeOverride: scope,
        });
        ctx.setResult({ executionId });
      } catch (error) {
        if (error instanceof WorkflowError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to start workflow: ${message}`);
      }
    });

    this.registerHandler(WorkflowSubjects.rerun, async (ctx) => {
      const {
        executionId,
        mode,
        input,
        config,
        parentSessionId,
        triggerPayload,
        artifactRef,
        scope,
        executionHints,
        reason,
      } = ctx.payload;
      try {
        const rerunExecutionId = await rerunExecution(this.buildStartDeps(), {
          executionId,
          mode,
          input: normalizeStartInput(input),
          config: normalizeConfig(config),
          parentSessionId,
          triggerPayload,
          artifactRef,
          executionHints: normalizeExecutionHints(executionHints),
          scopeOverride: scope,
          reason,
        });
        ctx.setResult({ executionId: rerunExecutionId });
      } catch (error) {
        if (error instanceof WorkflowError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to rerun workflow: ${message}`);
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

    this.registerGateTimeoutHandlers();

    // Low-priority fallback: accept gate responses for executions that are
    // paused in storage but have no active in-process gate-node handler.
    // Active gate-node handlers registered by the runtime have higher priority
    // (default 0) and will intercept gate.respond before this fallback runs.
    this.addCleanup(
      this.bus.on(
        WorkflowSubjects.gate.respond,
        async (ctx) => {
          const { executionId, gateId, frameId, action, resumeData, reason } = ctx.payload;
          const accepted = await this.respondToPausedGate({
            executionId,
            gateId,
            frameId,
            action,
            resumeData: resumeData as JsonValue,
            reason,
          });
          ctx.setResult({ accepted });
        },
        { priority: -100 },
      ),
    );
  }

  /** Register timeout wakeup handlers for parked gates. */
  private registerGateTimeoutHandlers(): void {
    this.addCleanup(
      this.bus.on(WorkflowSubjects.gate.suspended, (ctx) => {
        this.gateTimeoutScheduler.schedule(ctx.payload);
      }),
    );
    this.addCleanup(
      this.bus.on(WorkflowSubjects.gate.resolved, (ctx) => {
        this.gateTimeoutScheduler.clear(ctx.payload.executionId, ctx.payload.stepId, ctx.payload.frameId);
      }),
    );
  }

  /**
   * Rebuild timeout wakeups for exit-based gates left waiting across executor restarts.
   *
   * Gate rows persist the effective timeout policy captured when the reviewer
   * prompt opened, so rehydration does not depend on the current workflow
   * definition or a definition snapshot being available. Expired deadlines are
   * scheduled with zero delay and redispatched by the same persisted-gate
   * timeout path used for live suspensions.
   */
  private async rehydratePausedGateTimeouts(): Promise<void> {
    const { gates } = await this.bus.request(WorkflowStorageSubjects.listPausedGateTimeouts, {});
    for (const gate of gates) {
      this.gateTimeoutScheduler.schedule(toGateTimeoutPayload(gate));
    }
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
          { runtimeLoopGates: active.runtimeLoopGates },
        );
        assertLoopGateHandlersPresent(active.workflow, active.runtimeLoopGates);
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
      } else if (outcome.status === 'paused') {
        active.execution.status = 'paused';
        await this.bus.request(WorkflowStorageSubjects.setExecution, { execution: active.execution });
        this.activeExecutions.delete(executionId);
      } else {
        await completeExecutionWithSuccess(finalizerDeps, active.execution, executionId, active.execution.startedAt);
      }
    } finally {
      this.workflowAbortControllers.delete(executionId);
    }
  }

  /**
   * Accept a gate response for an execution that is paused in storage.
   *
   * Checks that the execution is paused, the response targets a waiting gate
   * frame directly or by a unique gate node, and the submitted resume data
   * matches the persisted gate schema. On a valid response, updates the gate
   * instance to its resolved state and triggers a resume dispatch via
   * {@link resumePausedExecution}.
   *
   * Returns `false` without modifying state when the execution is not paused
   * or the gate response is ambiguous or invalid, allowing the bus to continue
   * to the next handler.
   * @param payload - Gate response payload from the bus request context.
   * @returns `true` when the gate was accepted and resume dispatched; `false` otherwise.
   */
  private async respondToPausedGate(payload: {
    readonly executionId: string;
    readonly gateId: string;
    readonly frameId?: string;
    readonly action: 'approve' | 'reject';
    readonly resumeData: JsonValue;
    readonly reason?: string;
  }): Promise<boolean> {
    const { executionId, gateId, frameId, resumeData, reason } = payload;
    const { execution } = await this.bus.request(WorkflowStorageSubjects.getExecution, { executionId });
    if (!isPausedWorkflowExecution(execution)) return false;

    const gate = await loadUniqueWaitingGateInstance(this.bus, { executionId, nodeId: gateId, frameId });
    if (gate === null) return false;

    const validation = validateGateResumeDataForSchema(gateId, gate.schema, resumeData);
    if (!validation.valid) return false;

    const { runContext } = await this.bus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    if (runContext === null) {
      throw new Error(`[WorkflowExecutor] Run context not found for paused execution: ${executionId}`);
    }
    await assertDurableResumeFramesPresent(this.bus, runContext);

    const { accepted } = await this.bus.request(WorkflowStorageSubjects.resolveWaitingGateInstance, {
      gate: {
        ...gate,
        status: payload.action === 'reject' ? 'rejected' : 'resumed',
        resumeData,
        ...(reason !== undefined ? { reason } : {}),
        resolvedAt: Date.now(),
      },
    });
    if (!accepted) return false;

    try {
      await this.resumePausedExecution(execution.id);
    } catch (error) {
      await restorePausedGateAfterResumeFailure(
        this.bus,
        this.activeExecutions,
        this.executionTasks,
        this.workflowAbortControllers,
        execution,
        gate,
        gateId,
      );
      throw error;
    }

    this.gateTimeoutScheduler.clear(executionId, gateId, gate.frameId);
    return true;
  }

  /**
   * Transition a paused execution back to running and re-dispatch it through
   * the configured runner infrastructure.
   * @param executionId - Execution to resume.
   */
  private async resumePausedExecution(executionId: string): Promise<void> {
    if (this.resumeDispatches.has(executionId)) return;
    this.resumeDispatches.add(executionId);
    try {
      const launched = await this.dispatchPausedExecutionResume(executionId);
      if (!launched) this.resumeDispatches.delete(executionId);
    } catch (error) {
      this.resumeDispatches.delete(executionId);
      throw error;
    }
  }

  /**
   * Dispatch a paused execution once durable resume state is available.
   * @param executionId - Execution to resume.
   * @returns True when a runner task was launched.
   */
  private async dispatchPausedExecutionResume(executionId: string): Promise<boolean> {
    const { runContext } = await this.bus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    if (runContext === null) {
      throw new Error(`[WorkflowExecutor] Run context not found for paused execution: ${executionId}`);
    }

    const definition: WorkflowDefinition =
      runContext.definitionSnapshot ??
      (await this.bus.request(WorkflowStorageSubjects.get, { id: runContext.workflowId })).workflow ??
      (() => {
        throw new Error(`[WorkflowExecutor] Workflow definition not found for paused execution: ${executionId}`);
      })();

    const { execution } = await this.bus.request(WorkflowStorageSubjects.getExecution, { executionId });
    if (execution === null) {
      throw new Error(`[WorkflowExecutor] Execution not found for paused execution: ${executionId}`);
    }
    if (execution.status !== 'paused') {
      return false;
    }

    await assertDurableResumeFramesPresent(this.bus, runContext);

    await this.bus.request(WorkflowStorageSubjects.setExecution, {
      execution: { ...execution, status: 'running' },
    });

    this.activeExecutions.set(executionId, {
      execution: { ...execution, status: 'running' },
      workflow: definition,
      runContext,
      runtimeHandlers: new Map(),
      runtimeLoopGates: new Map(),
    });

    const params = buildDefinitionRunnerParamsFromRunContext(runContext, definition, { resume: true });
    const executionTask = launchDefinitionExecutionTask(this.buildStartDeps(), params);
    const trackedExecutionTask = executionTask.finally(() => {
      this.resumeDispatches.delete(executionId);
    });
    this.executionTasks.set(executionId, trackedExecutionTask);
    void trackedExecutionTask;
    return true;
  }
}
