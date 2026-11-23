import type { RunCancellationHook, WorkflowRunnerSelector } from './workflow-runner-selector.js';
import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/core';
import type { ExtensionContext, IWorkflowRunner } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import type { AutomationTriggerBindingRuntime } from '@makaio/services-core/automation-trigger';
import { WorkflowTriggerReconciler } from './workflow-trigger-reconciler.js';
import type { ExecutorConfig, WorkflowMaterializationSpecResolver, WorkflowWorkspaceRootResolver } from './types.js';
import { WorkflowExecutor } from './workflow-executor.js';

/**
 * Options for constructing a {@link WorkflowEngineService}.
 *
 * All fields are optional — when omitted the service uses the in-process
 * workflow scheduler and default executor config.
 */
export interface WorkflowEngineServiceOptions {
  /**
   * Workflow-level runner for dispatching full workflow executions to an
   * isolated environment (worker thread pool, child process, container).
   *
   * When provided the executor delegates each new execution to this runner
   * instead of running it in-process via the DAG scheduler.
   * When omitted, execution falls back to the in-process DAG scheduler.
   */
  workflowRunner?: IWorkflowRunner;
  /** Partial executor configuration merged with defaults. */
  executorConfig?: Partial<ExecutorConfig>;
  /** Host-owned resolvers that create portable specs for path-backed starts. */
  workflowMaterializationSpecResolvers?: readonly WorkflowMaterializationSpecResolver[];
  /**
   * Resolves the host-owned automation trigger binding runtime.
   *
   * Declarative workflow triggers are consumer subscriptions on that runtime, so
   * this is the seam through which the engine reaches trigger sources it does not
   * own. Resolved per reconciliation rather than captured, so a runtime that
   * restarts is picked up by the next refresh.
   *
   * When omitted — or when the resolver returns `undefined` — the engine runs
   * without declarative triggers: direct `WorkflowSubjects.start` requests still
   * work, which is the invocation-only mode a workflow with `triggers: []` uses.
   */
  automationTriggerBindingRuntime?: () => AutomationTriggerBindingRuntime | undefined;
}

/**
 * Workflow engine package service.
 *
 * Owns the boot lifecycle for the workflow executor and the trigger reconciler so
 * stored triggers become active during normal runtime package startup.
 */
export class WorkflowEngineService extends BaseService {
  private readonly workflowExecutor: WorkflowExecutor;
  private readonly triggerReconcilerInstance: WorkflowTriggerReconciler;
  private readonly workspaceRootResolvers = new Set<WorkflowWorkspaceRootResolver>();

  /**
   * @param bus - Shared runtime bus.
   * @param namespaces - Extension capability used for finalizer namespace leases.
   * @param options - Optional workflow runner and executor config overrides.
   */
  public constructor(
    bus: IMakaioBus,
    namespaces: ExtensionContext['namespaces'],
    options?: WorkflowEngineServiceOptions,
  ) {
    super(bus);
    this.workflowExecutor = new WorkflowExecutor(bus, namespaces, options?.executorConfig, options?.workflowRunner);
    for (const resolver of options?.workflowMaterializationSpecResolvers ?? []) {
      this.workflowExecutor.registerWorkflowMaterializationSpecResolver(resolver);
    }
    const resolveRuntime = options?.automationTriggerBindingRuntime;
    this.triggerReconcilerInstance = new WorkflowTriggerReconciler(bus, () => resolveRuntime?.());
  }

  /**
   * Executor owned by this package service.
   * @returns Workflow executor instance.
   */
  public get executor(): WorkflowExecutor {
    return this.workflowExecutor;
  }

  /**
   * Register a named workflow success finalizer with the owned executor.
   *
   * Compiled workflow definitions opt into this registration through their
   * immutable `successFinalizerId`; registration alone never changes ordinary
   * workflow completion behavior.
   * @param finalizerId - Stable lifecycle-finalizer identity.
   * @returns Idempotent cleanup that unregisters this exact registration.
   */
  public registerSuccessFinalizer(finalizerId: string): Promise<() => void> {
    return this.workflowExecutor.registerSuccessFinalizer(finalizerId);
  }

  /**
   * Accept a terminal result for a durable authority-owned runner execution.
   * @param call - Call context of the message that delivers the result.
   * @param executionId - Durable authority-owned execution identity.
   * @param result - Correlated terminal result returned by the runner.
   * @returns The current durable status after acceptance.
   */
  public acceptAuthorityRunnerResult(
    call: CallContext,
    executionId: string,
    result: Parameters<WorkflowExecutor['acceptAuthorityRunnerResult']>[2],
  ): ReturnType<WorkflowExecutor['acceptAuthorityRunnerResult']> {
    return this.workflowExecutor.acceptAuthorityRunnerResult(call, executionId, result);
  }

  /**
   * Apply the technical failure already accepted by the host.
   * @param call - Call context of the outcome submission.
   * @param executionId - Owner of the technical failure.
   * @param error - Failure text that belongs to the owner.
   * @returns Durable lifecycle status after the failure.
   */
  public acceptAuthorityTechnicalFailure(
    call: CallContext,
    executionId: string,
    error: string,
  ): ReturnType<WorkflowExecutor['acceptAuthorityTechnicalFailure']> {
    return this.workflowExecutor.acceptAuthorityTechnicalFailure(call, executionId, error);
  }

  /**
   * Apply a cancellation observed by the host.
   * @param call - Call context of the outcome submission.
   * @param executionId - Execution whose worker has stopped.
   * @param reason - Optional reason reported by the host.
   * @returns Durable lifecycle status after cancellation.
   */
  public acceptAuthorityCancellation(
    call: CallContext,
    executionId: string,
    reason?: string,
  ): ReturnType<WorkflowExecutor['acceptAuthorityCancellation']> {
    return this.workflowExecutor.acceptAuthorityCancellation(call, executionId, reason);
  }

  /**
   * Use a host selector to choose a runner for definition-backed runs.
   * @param selector - Selection callback owned by the host.
   * @returns Cleanup for this registration.
   */
  public registerWorkflowRunnerSelector(selector: WorkflowRunnerSelector): () => void {
    return this.workflowExecutor.registerWorkflowRunnerSelector(selector);
  }

  /**
   * Use a host callback to persist cancel intent before the lifecycle transition.
   * @param hook - Cancellation callback owned by the host.
   * @returns Cleanup for this registration.
   */
  public registerRunCancellationHook(hook: RunCancellationHook): () => void {
    return this.workflowExecutor.registerRunCancellationHook(hook);
  }

  /**
   * Request cancellation of active runs before the host drains its workers.
   * @param call - Call context of the host shutdown.
   * @param reason - Reason recorded for each cancelled run.
   * @returns Promise that resolves after cancellation has been requested.
   */
  public cancelActiveRuns(call: CallContext, reason: string): Promise<void> {
    return this.workflowExecutor.cancelActiveRuns(call, reason);
  }

  /**
   * Abort and drain run tasks after the host has released its workers.
   * @param call - Call context of the host shutdown.
   * @returns Promise that resolves once the runs have settled.
   */
  public settleRuns(call: CallContext): Promise<void> {
    return this.workflowExecutor.settleRuns(call);
  }

  /**
   * Declarative trigger reconciler owned by this package service.
   * @returns Workflow trigger reconciler instance.
   */
  public get triggerReconciler(): WorkflowTriggerReconciler {
    return this.triggerReconcilerInstance;
  }

  /**
   * Register a host resolver used to freeze a path-backed workflow's workspace
   * reference before the durable run context is written.
   * @param resolver - Host-owned resolver.
   * @returns Idempotent cleanup that unregisters this resolver.
   */
  public registerWorkflowMaterializationSpecResolver(resolver: WorkflowMaterializationSpecResolver): () => void {
    return this.workflowExecutor.registerWorkflowMaterializationSpecResolver(resolver);
  }

  /**
   * Register a host-owned workspace-root resolver.
   * @param resolver - Resolver to consult before the boot-level fallback resolver.
   * @returns Idempotent cleanup that unregisters this exact resolver.
   */
  public registerWorkspaceRootResolver(resolver: WorkflowWorkspaceRootResolver): () => void {
    this.workspaceRootResolvers.add(resolver);
    return () => {
      this.workspaceRootResolvers.delete(resolver);
    };
  }

  /**
   * Resolve a portable workspace identifier through registered host resolvers.
   * @param workspaceId - Portable workspace identifier from a materialization spec.
   * @returns The first registered root, or `undefined` when no resolver recognizes the identifier.
   */
  public async resolveWorkspaceRoot(workspaceId: string): Promise<string | undefined> {
    for (const resolver of this.workspaceRootResolvers) {
      const workspaceRoot = await resolver(workspaceId);
      if (workspaceRoot !== undefined) return workspaceRoot;
    }
    return undefined;
  }

  /**
   * Initialize executor handlers before the trigger reconciler can fire starts.
   * @returns Promise that resolves once all child services are initialized.
   */
  protected async onInit(): Promise<void> {
    this.addCleanup(() => this.destroyOwnedServices());
    await this.workflowExecutor.init();
    await this.triggerReconcilerInstance.init();
  }

  /**
   * Tear down child services in reverse boot order.
   * @returns Promise that resolves once all child services are destroyed.
   */
  private async destroyOwnedServices(): Promise<void> {
    const errors: unknown[] = [];
    for (const destroy of [() => this.triggerReconcilerInstance.destroy(), () => this.workflowExecutor.destroy()]) {
      try {
        await destroy();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Workflow engine service teardown failed');
    }
  }
}
