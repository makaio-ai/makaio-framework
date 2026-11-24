/* eslint max-lines: ["error", { "max": 620, "skipBlankLines": true, "skipComments": true }], max-lines-per-function: ["error", { "max": 130, "skipBlankLines": true, "skipComments": true }] */
import type { IMakaioBus } from '@makaio/bus-core';
import { isInProcessCaller, type CallContext } from '@makaio/core';
import {
  SessionSubjects,
  WORKFLOW_CANCELLED_REASON,
  WorkflowError,
  createWorkflowCancelSubject,
  type ExtensionContext,
  type IWorkflowRunner,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowRunResult,
  createWorkflowFinalizerNamespace,
} from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { WorkflowSubjects } from './namespace.js';
import { registerDrizzleWorkflowStorage } from './storage/handler.js';
import {
  DEFAULT_EXECUTOR_CONFIG,
  type ActiveRunnerStep,
  type ExecutorConfig,
  type ActiveExecution,
  type WorkflowMaterializationSpecResolver,
} from './types.js';
import {
  registerWorkflowStorageDelegationHandlers,
  registerWorkflowStateHandlers,
} from './workflow-executor-handlers.js';
import {
  cancelExecution,
  requestExecutionCancellation,
  completeExecutionWithFailure,
  completeExecutionWithSuccess,
  recoverSuccessFinalizations,
  type FinalizerDeps,
  type WorkflowSuccessFinalizer,
} from './workflow-execution-finalizer.js';
import type { RunCancellationHook, WorkflowRunnerSelector } from './workflow-runner-selector.js';
import type { RunnerTaskDeps } from './workflow-runner-tasks.js';
import { startExecution, startFileExecution, type StartExecutionDeps } from './workflow-execution-start.js';
import { rerunExecution } from './workflow-execution-rerun.js';
import { RuntimeContext, resolveEphemeralPlatformFields } from './runtime/runtime-context.js';
import { executeSequence } from './runtime/primitive-runtime.js';
import { assertLoopCheckHandlersPresent } from './runtime/loop-check-handlers.js';
import type { NodeOutcome } from './runtime/node-execution.js';
import { resolveWorkflowArtifactBinding } from './artifact-context/artifact-binding.js';
import { normalizeConfig, normalizeStartInput } from './workflow-executor-input-normalization.js';
import { buildWorkflowRunContext } from './workflow-run-context-builder.js';
import { registerAuthorityStateBootstrapHandler } from './authority-state-bootstrap.js';
import { registerDelegateResultFinalizationGateway } from './delegate-result-finalization-gateway.js';
import { acceptWorkflowTechnicalFailure } from './workflow-technical-failure.js';
import { acceptWorkflowCancellation } from './workflow-cancellation-outcome.js';
import {
  acceptAuthorityRunnerResult as acceptRunnerResult,
  loadAuthorityRunnerContext as loadRunnerContext,
} from './authority-runner.js';

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
  /**
   * Per-execution abort controllers used to cancel workflow-level runners.
   * Keyed by execution ID; only populated when a {@link IWorkflowRunner} is used.
   */
  private readonly workflowAbortControllers = new Map<string, AbortController>();
  private readonly successFinalizers = new Map<string, WorkflowSuccessFinalizer>();
  private readonly durableLifecycleTransitions = new Map<string, Promise<void>>();
  private readonly lifecyclePublications = new Map<string, Promise<void>>();
  private readonly publishingLifecycleExecutions = new Set<string>();
  private runnerSelection?: { readonly select: WorkflowRunnerSelector };
  private runCancellation?: { readonly record: RunCancellationHook };
  private readonly materializationSpecResolvers = new Set<WorkflowMaterializationSpecResolver>();

  /**
   * Create a new workflow executor.
   * @param bus - The message bus for communication
   * @param namespaces - Extension capability for success finalizer registration.
   * @param config - Optional partial configuration (merged with defaults)
   * @param workflowRunner - Optional workflow-level runner for isolated execution
   */
  public constructor(
    bus: IMakaioBus,
    private readonly namespaces: ExtensionContext['namespaces'],
    config?: Partial<ExecutorConfig>,
    private readonly workflowRunner?: IWorkflowRunner,
  ) {
    super(bus);
    this.config = { ...DEFAULT_EXECUTOR_CONFIG, ...config };
  }

  /**
   * Register the single host selector for definition-backed runs.
   * @param select - Selector called with the originating execution request.
   * @returns Idempotent release of this registration.
   */
  public registerWorkflowRunnerSelector(select: WorkflowRunnerSelector): () => void {
    if (this.runnerSelection !== undefined) throw new Error('Workflow runner selector already registered');
    const registration = { select };
    this.runnerSelection = registration;
    return () => {
      if (this.runnerSelection === registration) this.runnerSelection = undefined;
    };
  }

  /**
   * Register the single host recorder of cancel intent.
   * @param record - Hook called before the owner transitions to cancelled.
   * @returns Idempotent release of this registration.
   */
  public registerRunCancellationHook(record: RunCancellationHook): () => void {
    if (this.runCancellation !== undefined) throw new Error('Run cancellation hook already registered');
    const registration = { record };
    this.runCancellation = registration;
    return () => {
      if (this.runCancellation === registration) this.runCancellation = undefined;
    };
  }

  /**
   * Register a host resolver used to freeze workspace materialization before a
   * path-backed execution is persisted.
   * @param resolver - Host-owned resolver.
   * @returns Idempotent cleanup that unregisters this resolver.
   */
  public registerWorkflowMaterializationSpecResolver(resolver: WorkflowMaterializationSpecResolver): () => void {
    this.materializationSpecResolvers.add(resolver);
    return () => this.materializationSpecResolvers.delete(resolver);
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
  public registerSuccessFinalizer(finalizerId: string): Promise<() => void> {
    // ORIGIN: Host registration drains the durable claims of every run under the executor carrier.
    // Shared work, not start: the sweep finalizes many runs, so no single run's principal applies.
    return this.registerSuccessFinalizerWithCall(this.bus.own('shared-work'), finalizerId);
  }

  /**
   * Register one success finalizer and recover its claims.
   * @param call - Context for the result being replayed, or the carrier's own context for a standalone sweep.
   * @param finalizerId - Stable finalizer identity used by the durable claim.
   * @param replayingExecutionId - Execution receiving the current result, if any.
   * @returns Idempotent cleanup after any recoverable claims have been drained.
   * @throws When another active registration already owns `finalizerId`.
   */
  private async registerSuccessFinalizerWithCall(
    call: CallContext,
    finalizerId: string,
    replayingExecutionId?: string,
  ): Promise<() => void> {
    if (!this.initialized) {
      throw new Error('[WorkflowExecutor] Initialize the executor before registering success finalizers');
    }
    if (this.successFinalizers.has(finalizerId)) {
      throw new Error(`[WorkflowExecutor] Success finalizer already registered: ${finalizerId}`);
    }
    const { namespace, subjects } = createWorkflowFinalizerNamespace(finalizerId);
    const lease = this.namespaces.lease(namespace);
    const registration: WorkflowSuccessFinalizer = { finalizerId, finalizeSubject: subjects.finalize };
    this.successFinalizers.set(finalizerId, registration);
    const dispose = (): void => {
      if (this.successFinalizers.get(finalizerId) === registration) {
        this.successFinalizers.delete(finalizerId);
        lease.release();
      }
    };
    try {
      await recoverSuccessFinalizations(call, { ...this.buildFinalizerDeps(), replayingExecutionId });
    } catch (error) {
      dispose();
      throw error;
    }
    return dispose;
  }

  /**
   * Accept a terminal result from an authority-dispatched runner that was not
   * launched through this executor's in-memory task registry.
   *
   * Durable execution and run-context rows remain the source of truth. The
   * executor temporarily adopts a missing active entry and delegates to the
   * same runner-result finalization path used by executor-owned tasks.
   * @param call - Call context of the message that delivers the result.
   * @param executionId - Durable authority-owned execution identity.
   * @param result - Correlated terminal runner result.
   * @returns The durable status after acceptance, including pending success finalization.
   */
  public async acceptAuthorityRunnerResult(
    call: CallContext,
    executionId: string,
    result: WorkflowRunResult,
  ): Promise<{ accepted: boolean; status: WorkflowExecution['status'] }> {
    return acceptRunnerResult(
      call,
      {
        bus: this.bus,
        activeExecutions: this.activeExecutions,
        buildFinalizerDeps: () => this.buildFinalizerDeps(),
        registerResultFinalizer: (resultCall, workflow, executionId) =>
          this.registerAuthorityResultFinalizer(resultCall, workflow, executionId),
      },
      executionId,
      result,
    );
  }

  /**
   * Fail the workflow owner after the authority reports a technical failure.
   * Startup and Preparation failures can precede loading the workflow definition,
   * so this path uses the durable owner context, not a fabricated runner result.
   * @param call - Call context of the work that commits the failure.
   * @param executionId - Durable authority-owned execution identity.
   * @param error - Final error text reported by the authority.
   * @returns The durable status after idempotent failure convergence.
   */
  public readonly acceptAuthorityTechnicalFailure = (call: CallContext, executionId: string, error: string) =>
    acceptWorkflowTechnicalFailure(call, this.buildFinalizerDeps(), executionId, error);

  /**
   * Cancel the workflow owner after the authority reports that work has stopped.
   * @param call - Call context of the work that commits the cancellation.
   * @param executionId - Durable authority-owned execution identity.
   * @param reason - Optional explanation supplied by the authority.
   * @returns The durable status after idempotent cancellation convergence.
   */
  public readonly acceptAuthorityCancellation = (call: CallContext, executionId: string, reason?: string) =>
    acceptWorkflowCancellation(call, this.buildFinalizerDeps(), executionId, reason);

  private async loadAuthorityRunnerContext(call: CallContext, executionId: string, workflowId: string) {
    return loadRunnerContext(call, this.bus, executionId, workflowId);
  }

  private registerAuthorityResultFinalizer(
    call: CallContext,
    workflow: WorkflowDefinition,
    executionId: string,
  ): Promise<(() => void) | undefined> {
    if (!workflow.successFinalizerId || this.successFinalizers.has(workflow.successFinalizerId)) {
      return Promise.resolve(undefined);
    }
    return this.registerSuccessFinalizerWithCall(call, workflow.successFinalizerId, executionId);
  }

  /**
   * Register all bus handlers via BaseService lifecycle.
   * Called once by `init()` — idempotency is handled by BaseService.
   */
  protected onInit(): void {
    this.registerExecutionHandlers();
    // An authority runner can finish bootstrap while onDestroy drains its
    // admitted execution, so this completion protocol remains available until
    // the drain is finished.
    this.addCleanup(
      registerAuthorityStateBootstrapHandler(this.bus, (executionId, definition) => {
        const active = this.activeExecutions.get(executionId);
        if (active !== undefined) active.workflow = definition;
      }),
    );
    // Delegate results complete already-admitted remote work during the drain.
    this.addCleanup(registerDelegateResultFinalizationGateway(this.bus));
    registerWorkflowStorageDelegationHandlers(this.bus).forEach((cleanup) => this.addHandlerCleanup(cleanup));
    registerWorkflowStateHandlers(this.bus).forEach((cleanup) => this.addHandlerCleanup(cleanup));
  }

  /**
   * Request cancellation of every active execution before draining runners.
   * @param call - Call context of the host shutdown.
   * @param reason - Reason recorded with each cancelled execution.
   */
  public async cancelActiveRuns(call: CallContext, reason: string): Promise<void> {
    const finalizerDeps = this.buildFinalizerDeps();
    // 1. Cancel all active executions (aborts controllers, schedules hard-kill timers).
    await Promise.allSettled(
      [...this.activeExecutions.keys()].map(async (executionId) => {
        const cancelled = await requestExecutionCancellation(call, finalizerDeps, executionId, reason);
        if (cancelled) {
          this.workflowAbortControllers.get(executionId)?.abort();
          this.workflowAbortControllers.delete(executionId);
        }
      }),
    );
  }

  /**
   * Abort and drain runner tasks and pending lifecycle operations.
   * @param _call - Call context of the host shutdown.
   */
  public async settleRuns(_call: CallContext): Promise<void> {
    // Abort all pending workflow-level runners (cooperative cancellation).
    for (const controller of this.workflowAbortControllers.values()) {
      controller.abort();
    }
    this.workflowAbortControllers.clear();
    // Await all execution tasks to settle (runners terminate via abort or forceKill).
    await Promise.allSettled(this.executionTasks.values());
    await Promise.allSettled(this.durableLifecycleTransitions.values());
    await Promise.allSettled(this.lifecyclePublications.values());
  }

  /** Release in-flight executions and abort shell processes. */
  protected async onDestroy(): Promise<void> {
    const call = this.bus.own('stop');
    await this.cancelActiveRuns(call, 'Workflow engine shutdown');
    await this.settleRuns(call);
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
      recordCancellationIntent: this.runCancellation?.record,
      notifyRunCancellation: (call, executionId, reason) => this.notifyRunCancellation(call, executionId, reason),
      successFinalizers: this.successFinalizers,
      resolveSuccessFinalizerId: (executionId) => this.activeExecutions.get(executionId)?.workflow.successFinalizerId,
      durableLifecycleTransitions: this.durableLifecycleTransitions,
      lifecyclePublications: this.lifecyclePublications,
      publishingLifecycleExecutions: this.publishingLifecycleExecutions,
    };
  }

  /**
   * Deliver best-effort worker control only after owner-authorized intent commits.
   * @param call - Call context of the cancellation that was accepted.
   * @param executionId - Owner whose cancellation request was accepted.
   * @param reason - Optional cancellation explanation.
   */
  private async notifyRunCancellation(call: CallContext, executionId: string, reason?: string): Promise<void> {
    this.workflowAbortControllers.get(executionId)?.abort(reason ?? WORKFLOW_CANCELLED_REASON);
    await this.bus
      .emit(call, createWorkflowCancelSubject(`workflow.${executionId}.cancel`), { executionId, reason })
      .catch((error: unknown) => {
        console.error(`[WorkflowExecutor] Failed to emit workflow cancel for ${executionId}:`, error);
      });
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
   * @param call - Call context of the start request.
   * @param parentSessionId - Optional parent session identifier.
   * @returns Parent session working directory, or the executor default cwd.
   * @throws When `parentSessionId` is provided but the session is not found.
   */
  private async resolveExecutionWorkspaceRoot(call: CallContext, parentSessionId?: string): Promise<string> {
    if (!parentSessionId) {
      return this.config.platformDefaults.cwd;
    }

    const { session } = await this.bus.request(call, SessionSubjects.get, { sessionId: parentSessionId });
    if (session === null) {
      throw new Error(`[WorkflowExecutor] Parent session not found: ${parentSessionId}`);
    }
    return session.targetWorkingDirectory ?? this.config.platformDefaults.cwd;
  }

  /**
   * Derive ephemeral platform fields from the current process environment.
   *
   * Delegates to the shared {@link resolveEphemeralPlatformFields} helper
   * with config-specific overrides for workspace root and Makaio home.
   * @returns Ephemeral platform fields for the current machine.
   */
  private resolveEphemeralPlatformFields() {
    return resolveEphemeralPlatformFields(this.config.platformDefaults.cwd, this.config.makaioHome);
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
      workflowRunnerSelector: this.runnerSelection?.select,
      buildRunContext: (params) => buildWorkflowRunContext(params, this.config),
      buildRunnerTaskDeps: (runner) => this.buildRunnerTaskDeps(runner),
      buildFinalizerDeps: () => this.buildFinalizerDeps(),
      resolveExecutionWorkspaceRoot: (call, parentSessionId) =>
        this.resolveExecutionWorkspaceRoot(call, parentSessionId),
      runExecution: (call, executionId) => this.runExecution(call, executionId),
      materializationSpecResolvers: this.materializationSpecResolvers,
    };
  }

  /** Register execution control handlers (start, cancel). */
  private registerExecutionHandlers(): void {
    this.registerHandler(WorkflowSubjects.acceptAuthorityRunnerResult, async (ctx) => {
      if (!isInProcessCaller(ctx.call)) throw new Error('authority runner result acceptance is local-authority only');
      const { executionId, result } = ctx.payload;
      // Runtime parsing has already established the worker-result contract.
      // Its inferred artifact shape is wider than the hand-authored interface.
      ctx.setResult(await this.acceptAuthorityRunnerResult(ctx.call, executionId, result as WorkflowRunResult));
    });
    this.registerHandler(WorkflowSubjects.start, async (ctx) => {
      const { workflowId, input, config, parentSessionId, triggerPayload, artifactRef, scope } = ctx.payload;
      try {
        const executionId = await startExecution(ctx.call, this.buildStartDeps(), workflowId, {
          input: normalizeStartInput(input),
          config: normalizeConfig(config) ?? {},
          parentSessionId,
          triggerPayload,
          artifactRef,
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
      const { executionId, mode, input, config, parentSessionId, triggerPayload, artifactRef, scope, reason } =
        ctx.payload;
      try {
        const rerunExecutionId = await rerunExecution(ctx.call, this.buildStartDeps(), {
          executionId,
          mode,
          input: normalizeStartInput(input),
          config: normalizeConfig(config),
          parentSessionId,
          triggerPayload,
          artifactRef,
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
      const { filePath, materializationSpec, triggerPayload, triggerMode, scope } = ctx.payload;
      try {
        const executionId = await startFileExecution(ctx.call, this.buildStartDeps(), filePath, {
          ...(materializationSpec !== undefined ? { materializationSpec } : {}),
          triggerPayload,
          triggerMode,
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
      const cancelled = await requestExecutionCancellation(ctx.call, this.buildFinalizerDeps(), executionId, reason);
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
   * @param call - Call context of the message that launched this run.
   * @param executionId - The execution ID.
   */
  private async runExecution(call: CallContext, executionId: string): Promise<void> {
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
          call,
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
          { context: this.resolveEphemeralPlatformFields(), env: active.runContext.env },
          { runtimeLoopChecks: active.runtimeLoopChecks, stepTimeoutMs: this.config.stepTimeoutMs },
        );
        assertLoopCheckHandlersPresent(active.workflow, active.runtimeLoopChecks);
        const expressionCtx = runtimeCtx.buildExpressionContext();
        outcome = await executeSequence(call, active.workflow.root, runtimeCtx, expressionCtx);
      } catch (error) {
        if (abortController.signal.aborted || active.execution.status === 'cancelled') {
          await cancelExecution(call, this.buildFinalizerDeps(), executionId, WORKFLOW_CANCELLED_REASON);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        await completeExecutionWithFailure(call, this.buildFinalizerDeps(), active.execution, executionId, message);
        return;
      }

      const finalizerDeps = this.buildFinalizerDeps();
      if (outcome.status === 'cancelled' || abortController.signal.aborted || active.execution.status === 'cancelled') {
        await cancelExecution(call, finalizerDeps, executionId, WORKFLOW_CANCELLED_REASON);
      } else if (outcome.status === 'failed') {
        await completeExecutionWithFailure(call, finalizerDeps, active.execution, executionId, outcome.error);
      } else {
        await completeExecutionWithSuccess(
          call,
          finalizerDeps,
          active.execution,
          executionId,
          active.execution.startedAt,
        );
      }
    } finally {
      this.workflowAbortControllers.delete(executionId);
    }
  }
}
