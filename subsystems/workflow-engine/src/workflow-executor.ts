/* eslint max-lines: ["error", { "max": 620, "skipBlankLines": true, "skipComments": true }], max-lines-per-function: ["error", { "max": 130, "skipBlankLines": true, "skipComments": true }] */
import type { IMakaioBus } from '@makaio/bus-core';
import { createBusNamespace, isInProcessCaller, localSubject, type CallContext } from '@makaio/core';
import { z } from 'zod';
import {
  SessionSubjects,
  WORKFLOW_CANCELLED_REASON,
  WorkflowError,
  createWorkflowCancelSubject,
  type IWorkflowRunner,
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
  withExecutionDurableTransition,
  completeExecutionWithFailure,
  completeExecutionWithSuccess,
  recoverSuccessFinalizations,
  type FinalizerDeps,
  type WorkflowSuccessFinalizer,
} from './workflow-execution-finalizer.js';
import { buildDefinitionRunnerParamsFromRunContext, type RunnerTaskDeps } from './workflow-runner-tasks.js';
import { startExecution, startFileExecution, type StartExecutionDeps } from './workflow-execution-start.js';
import { rerunExecution } from './workflow-execution-rerun.js';
import { launchDefinitionExecutionTask, selectDefinitionExecutionDispatch } from './workflow-definition-dispatch.js';
import { RuntimeContext, resolveEphemeralPlatformFields } from './runtime/runtime-context.js';
import { executeSequence } from './runtime/primitive-runtime.js';
import { assertLoopGateHandlersPresent } from './runtime/loop-gate-handlers.js';
import type { NodeOutcome } from './runtime/node-execution.js';
import { resolveWorkflowArtifactBinding } from './artifact-context/artifact-binding.js';
import { validateGateResumeDataForSchema } from './runtime/gate-resume-validation.js';
import { WorkflowGateTimeoutScheduler } from './workflow-gate-timeout-scheduler.js';
import { normalizeConfig, normalizeStartInput } from './workflow-executor-input-normalization.js';
import { buildWorkflowRunContext } from './workflow-run-context-builder.js';
import {
  assertDurableResumeFramesPresent,
  isPausedWorkflowExecution,
  loadUniqueWaitingGateInstance,
  restorePausedGateAfterResumeFailure,
  toGateTimeoutPayload,
} from './workflow-resume-state.js';
import { registerAuthorityStateBootstrapHandler } from './authority-state-bootstrap.js';
import { registerOutcomeSubmissionHandler } from './workflow-outcome-submission.js';
import { registerRuntimeLifecycleHandlers } from './runtime-lifecycle-handlers.js';
import { registerBootstrapStartHandler } from './bootstrap-start-handler.js';
import { registerDelegateResultFinalizationGateway } from './delegate-result-finalization-gateway.js';
import type { ExecutionAttemptAuthority } from './execution-attempt-authority.js';
import type {
  WorkflowAttemptOutcome,
  WorkflowAttemptTechnicalFailure,
  WorkflowAttemptCancellation,
} from './workflow-attempt-outcome.js';
import { acceptWorkflowTechnicalFailure } from './workflow-technical-failure.js';
import { acceptWorkflowCancellation } from './workflow-cancellation-outcome.js';
import { acceptWorkflowOwnerOutcome } from './workflow-owner-outcome.js';
import type { OutcomeConvergenceInput } from './outcome-convergence.js';
import { registerExecutionTask } from './workflow-execution-task-registration.js';
import {
  acceptAuthorityRunnerResult as acceptRunnerResult,
  loadAuthorityRunnerContext as loadRunnerContext,
} from './authority-runner.js';

const GateTimeoutNamespace = createBusNamespace('workflow-gate-timeout', {
  resume: localSubject({ request: z.object({ executionId: z.string() }), response: z.object({}) }),
});
const GateTimeoutSubjects = GateTimeoutNamespace.subjects;

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
  private stopBootstrapWaits?: () => void;
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private readonly executionTasks = new Map<string, Promise<void>>();
  private readonly shellAbortControllers = new Map<string, AbortController>();
  private readonly activeRunnerSteps = new Map<string, ActiveRunnerStep>();
  private readonly gateTimeoutScheduler: WorkflowGateTimeoutScheduler;
  /**
   * Per-execution abort controllers used to cancel workflow-level runners.
   * Keyed by execution ID; only populated when a {@link IWorkflowRunner} is used.
   */
  private readonly workflowAbortControllers = new Map<string, AbortController>();
  private readonly successFinalizers = new Map<string, WorkflowSuccessFinalizer>();
  private readonly durableLifecycleTransitions = new Map<string, Promise<void>>();
  private readonly lifecyclePublications = new Map<string, Promise<void>>();
  private readonly publishingLifecycleExecutions = new Set<string>();
  private readonly materializationSpecResolvers = new Set<WorkflowMaterializationSpecResolver>();

  /**
   * Create a new workflow executor.
   * @param bus - The message bus for communication
   * @param config - Optional partial configuration (merged with defaults)
   * @param workflowRunner - Optional workflow-level runner for isolated execution
   * @param executionAttemptAuthority - Optional Authority for Worker dispatch runners
   */
  public constructor(
    bus: IMakaioBus,
    config?: Partial<ExecutorConfig>,
    private readonly workflowRunner?: IWorkflowRunner,
    private readonly executionAttemptAuthority?: ExecutionAttemptAuthority<WorkflowAttemptOutcome>,
  ) {
    super(bus);
    this.config = { ...DEFAULT_EXECUTOR_CONFIG, ...config };
    // ORIGIN: A timer wakeup enters through a local request so the runner receives a forwardable call.
    this.gateTimeoutScheduler = new WorkflowGateTimeoutScheduler(bus, async (executionId) => {
      await bus.request(bus.own('schedule'), GateTimeoutSubjects.resume, { executionId });
    });
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
    this.bus.registerNamespace(namespace);
    const registration: WorkflowSuccessFinalizer = { finalizerId, finalizeSubject: subjects.finalize };
    this.successFinalizers.set(finalizerId, registration);
    try {
      await recoverSuccessFinalizations(call, { ...this.buildFinalizerDeps(), replayingExecutionId });
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
   * Fail the workflow owner after a technical Attempt outcome has been committed.
   * Startup and Preparation failures can precede loading the workflow definition,
   * so this path uses the durable owner context, not a fabricated runner result.
   * @param call - Call context of the work that commits the failure.
   * @param executionId - Durable authority-owned execution identity.
   * @param failure - Canonical technical failure retained in Attempt storage.
   * @returns The durable status after idempotent failure convergence.
   */
  public readonly acceptAuthorityTechnicalFailure = (
    call: CallContext,
    executionId: string,
    failure: WorkflowAttemptTechnicalFailure,
  ) => acceptWorkflowTechnicalFailure(call, this.buildFinalizerDeps(), executionId, failure);

  /**
   * Cancel the workflow owner after its technical Attempt cancellation is committed.
   * @param call - Call context of the work that commits the cancellation.
   * @param executionId - Durable authority-owned execution identity.
   * @param cancellation - Canonical cancellation retained in Attempt storage.
   * @returns The durable status after idempotent cancellation convergence.
   */
  public readonly acceptAuthorityCancellation = (
    call: CallContext,
    executionId: string,
    cancellation: WorkflowAttemptCancellation,
  ) => acceptWorkflowCancellation(call, this.buildFinalizerDeps(), executionId, cancellation);

  /**
   * Interpret a canonical Attempt outcome under durable owner lifecycle ordering.
   * @param input - Committed outcome and its frozen control observation.
   * @returns Explicit lifecycle projection or technical-fact-only acceptance.
   */
  public readonly acceptAuthorityOutcome = (input: OutcomeConvergenceInput<WorkflowAttemptOutcome>) => {
    const { call } = input;
    return acceptWorkflowOwnerOutcome(
      call,
      {
        lifecycle: this.buildFinalizerDeps(),
        acceptTerminalResult: (outcomeCall, executionId, result) =>
          this.acceptAuthorityRunnerResult(outcomeCall, executionId, result),
        acceptTechnicalFailure: (outcomeCall, executionId, failure) =>
          this.acceptAuthorityTechnicalFailure(outcomeCall, executionId, failure),
        acceptCancellation: (outcomeCall, executionId, cancellation) =>
          this.acceptAuthorityCancellation(outcomeCall, executionId, cancellation),
      },
      input,
    );
  };

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
  protected async onInit(): Promise<void> {
    this.registerExecutionHandlers();
    this.bus.registerNamespace(GateTimeoutNamespace);
    this.registerHandler(GateTimeoutSubjects.resume, async (ctx) => {
      await this.resumePausedExecution(ctx.call, ctx.payload.executionId);
      ctx.setResult({});
    });
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
    if (this.executionAttemptAuthority !== undefined) {
      this.stopBootstrapWaits = registerBootstrapStartHandler(this.bus, this.executionAttemptAuthority);
      this.addCleanup(this.stopBootstrapWaits);
      // Outcome submission completes already-admitted worker attempts.
      this.addCleanup(
        registerOutcomeSubmissionHandler(this.bus, {
          bus: this.bus,
          authority: this.executionAttemptAuthority,
          acceptOutcome: this.acceptAuthorityOutcome,
        }),
      );
      // Runtime registration and operation admission are the WorkerPool
      // protocol that onDestroy drains; keep them available until it settles.
      registerRuntimeLifecycleHandlers(this.bus, this.executionAttemptAuthority, (cleanup) => this.addCleanup(cleanup));
    }
    registerWorkflowStorageDelegationHandlers(this.bus).forEach((cleanup) => this.addHandlerCleanup(cleanup));
    registerWorkflowStateHandlers(this.bus).forEach((cleanup) => this.addHandlerCleanup(cleanup));
    await this.rehydratePausedGateTimeouts();
  }

  /**
   * Release in-flight executions and abort shell processes.
   * Called by `destroy()` before handler unsubscription.
   */
  protected async onDestroy(): Promise<void> {
    // BaseService runs addCleanup after onDestroy: stop bootstrap waits before draining work.
    this.stopBootstrapWaits?.();
    const finalizerDeps = this.buildFinalizerDeps();
    const call = this.bus.own('stop');
    // 1. Cancel all active executions (aborts controllers, schedules hard-kill timers).
    await Promise.allSettled(
      [...this.activeExecutions.keys()].map(async (executionId) => {
        const cancelled = await requestExecutionCancellation(
          call,
          finalizerDeps,
          executionId,
          'Workflow engine shutdown',
        );
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
    const authority = this.executionAttemptAuthority;
    return {
      bus: this.bus,
      activeExecutions: this.activeExecutions,
      shellAbortControllers: this.shellAbortControllers,
      activeRunnerSteps: this.activeRunnerSteps,
      cancelTimeoutMs: this.config.cancelTimeoutMs,
      requestAttemptCancellation:
        authority === undefined
          ? undefined
          : (executionId, reason) => authority.requestCancellation({ executionId, reason }),
      notifyAttemptCancellation: (call, executionId, reason) =>
        this.notifyAttemptCancellation(call, executionId, reason),
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
  private async notifyAttemptCancellation(call: CallContext, executionId: string, reason?: string): Promise<void> {
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
      buildRunContext: (params) => buildWorkflowRunContext(params, this.config),
      buildRunnerTaskDeps: (runner) => this.buildRunnerTaskDeps(runner),
      buildFinalizerDeps: () => this.buildFinalizerDeps(),
      resolveExecutionWorkspaceRoot: (call, parentSessionId) =>
        this.resolveExecutionWorkspaceRoot(call, parentSessionId),
      runExecution: (call, executionId) => this.runExecution(call, executionId),
      executionAttemptAuthority: this.executionAttemptAuthority,
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

    this.registerGateTimeoutHandlers();

    // Low-priority fallback: accept gate responses for executions that are
    // paused in storage but have no active in-process gate-node handler.
    // Active gate-node handlers registered by the runtime have higher priority
    // (default 0) and will intercept gate.respond before this fallback runs.
    this.addHandlerCleanup(
      this.bus.on(
        WorkflowSubjects.gate.respond,
        async (ctx) => {
          const { executionId, executionAttemptId, gateId, frameId, action, resumeData, reason } = ctx.payload;
          const accepted = await this.respondToPausedGate(ctx.call, {
            executionId,
            executionAttemptId,
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
    this.addHandlerCleanup(
      this.bus.on(WorkflowSubjects.gate.suspended, (ctx) => {
        this.gateTimeoutScheduler.schedule(ctx.payload);
      }),
    );
    this.addHandlerCleanup(
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
    const { gates } = await this.bus.request(this.bus.own('start'), WorkflowStorageSubjects.listPausedGateTimeouts, {});
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
   * @param call - Call context of the message that launched or resumed this run.
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
          { runtimeLoopGates: active.runtimeLoopGates },
        );
        assertLoopGateHandlersPresent(active.workflow, active.runtimeLoopGates);
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
      } else if (outcome.status === 'paused') {
        active.execution.status = 'paused';
        await this.bus.request(call, WorkflowStorageSubjects.setExecution, { execution: active.execution });
        this.activeExecutions.delete(executionId);
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
   * @param call - Call context of the gate response message.
   * @param payload - Gate response payload from the bus request context.
   * @returns `true` when the gate was accepted and resume dispatched; `false` otherwise.
   */
  private async respondToPausedGate(
    call: CallContext,
    payload: {
      readonly executionId: string;
      readonly executionAttemptId?: string;
      readonly gateId: string;
      readonly frameId?: string;
      readonly action: 'approve' | 'reject';
      readonly resumeData: JsonValue;
      readonly reason?: string;
    },
  ): Promise<boolean> {
    const { executionId, executionAttemptId, gateId, frameId, resumeData, reason } = payload;
    const { execution } = await this.bus.request(call, WorkflowStorageSubjects.getExecution, { executionId });
    if (!isPausedWorkflowExecution(execution)) return false;

    const gate = await loadUniqueWaitingGateInstance(call, this.bus, { executionId, nodeId: gateId, frameId });
    if (gate === null) return false;
    if (executionAttemptId !== gate.executionAttemptId) return false;

    const validation = validateGateResumeDataForSchema(gateId, gate.schema, resumeData);
    if (!validation.valid) return false;

    const { runContext } = await this.bus.request(call, WorkflowStorageSubjects.getRunContext, { executionId });
    if (runContext === null) {
      throw new Error(`[WorkflowExecutor] Run context not found for paused execution: ${executionId}`);
    }
    await assertDurableResumeFramesPresent(call, this.bus, runContext);

    const { accepted } = await this.bus.request(call, WorkflowStorageSubjects.resolveWaitingGateInstance, {
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
      await this.resumePausedExecution(call, execution.id);
    } catch (error) {
      await restorePausedGateAfterResumeFailure(
        call,
        this.buildFinalizerDeps(),
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
   * Dispatch a paused execution once durable resume state is available.
   * @param call - Call context of the message or wakeup that resumes the execution.
   * @param executionId - Execution to resume.
   */
  private async resumePausedExecution(call: CallContext, executionId: string): Promise<void> {
    const { runContext } = await this.bus.request(call, WorkflowStorageSubjects.getRunContext, { executionId });
    if (runContext === null) {
      throw new Error(`[WorkflowExecutor] Run context not found for paused execution: ${executionId}`);
    }

    const definition: WorkflowDefinition =
      runContext.definitionSnapshot ??
      (await this.bus.request(call, WorkflowStorageSubjects.get, { id: runContext.workflowId })).workflow ??
      (() => {
        throw new Error(`[WorkflowExecutor] Workflow definition not found for paused execution: ${executionId}`);
      })();

    await assertDurableResumeFramesPresent(call, this.bus, runContext);

    const params = buildDefinitionRunnerParamsFromRunContext(runContext, definition, { resume: true });
    const dispatch = selectDefinitionExecutionDispatch(this.buildStartDeps(), params);

    await withExecutionDurableTransition(this.buildFinalizerDeps(), executionId, async () => {
      // Frame loading may have yielded to cancellation. Re-read under the same
      // owner boundary that admits the next attempt; never resurrect stale state.
      const { execution } = await this.bus.request(call, WorkflowStorageSubjects.getExecution, { executionId });
      if (execution === null)
        throw new Error(`[WorkflowExecutor] Execution not found for paused execution: ${executionId}`);
      // Durable paused → running admission excludes duplicate gate/timeout
      // responses without blocking the next gate during this task's publication.
      if (execution.status !== 'paused') return;
      await this.bus.request(call, WorkflowStorageSubjects.setExecution, {
        execution: { ...execution, status: 'running' },
      });

      this.activeExecutions.set(executionId, {
        execution: { ...execution, status: 'running' },
        workflow: definition,
        runContext,
        runtimeHandlers: new Map(),
        runtimeLoopGates: new Map(),
      });

      const trackedExecutionTask = launchDefinitionExecutionTask(call, this.buildStartDeps(), params, dispatch);
      registerExecutionTask(this.executionTasks, executionId, trackedExecutionTask);
    });
  }
}
