import type { IMakaioBus } from '@makaio/bus-core';
import type {
  IWorkerNodeProvider,
  IWorkflowRunner,
  NormalizedWorkerNodeCapabilities,
  ProviderAllocationRef,
  WorkerNodeCapabilities,
  WorkerNodeProvisionRequest,
  WorkerNodeProvisionResult,
  WorkflowRunResult,
} from '@makaio/contracts';
import {
  BUILT_IN_THIN_WORKFLOW_PROVIDER_ID,
  PROVIDER_ALLOCATION_REF_VERSION,
  ProviderAllocationRefSchema,
  WorkerNodeCapabilitiesSchema,
  WorkerNodeSubjects,
} from '@makaio/contracts';
import { OutcomeDeliveryError, submitOutcomeWithAck, type OutcomeSubmitRetryConfig } from './outcome-submission.js';
import type { ThinWorkflowPiscinaRunWithReadiness } from './thin-workflow-piscina-runner.js';

/**
 * Construction options for {@link PiscinaThinWorkflowProvider}.
 */
export interface PiscinaThinWorkflowProviderOptions {
  /** Stable unique identifier for this provider instance. */
  readonly id: string;
  /** Human-readable label for display in UI and logs. */
  readonly displayName: string;
  /**
   * Underlying workflow runner used to execute incoming provision requests.
   *
   * Typically a {@link ThinWorkflowPiscinaRunner} instance, but any
   * {@link IWorkflowRunner} implementation is accepted so tests can supply
   * lightweight fakes without spawning real worker threads.
   */
  readonly runner: IWorkflowRunner;
  /**
   * Bus instance used to submit workflow outcomes through the Authority's
   * durable `control.outcome.submit` protocol after the runner settles.
   */
  readonly bus: IMakaioBus;
  /**
   * Capabilities advertised when this provider is registered.
   *
   * Overrides are merged onto the built-in local, delegating workflow
   * capability set. The Piscina runner shares the host process filesystem and
   * delegates agent/subagent execution to the host runtime.
   */
  readonly baseCapabilities?: Partial<WorkerNodeCapabilities>;
  /**
   * Optional retry configuration for outcome submission.
   *
   * The Piscina provider runs in-process, so the defaults are shorter
   * than the headless worker's remote defaults: 3 retries, 200 ms base
   * delay, 2 s cap, 10 s deadline.
   */
  readonly outcomeRetry?: OutcomeSubmitRetryConfig;
}

/**
 * In-process retry defaults for the Piscina provider. Shorter than
 * the headless worker's remote defaults because a persistently
 * failing local submit means the handler is unregistered — an
 * infrastructure failure, not a transient network issue.
 */
const PISCINA_OUTCOME_RETRY_DEFAULTS: OutcomeSubmitRetryConfig = {
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
  deadlineMs: 10_000,
};

const DEFAULT_BASE_CAPABILITIES: NormalizedWorkerNodeCapabilities = {
  persistentStorage: true,
  customCapabilities: ['workflow.local-runtime', 'workflow.thin-runner'],
  suspensionStrategy: 'wait-in-process',
  supportsRecovery: false,
  materializationModes: ['local-directory'],
};

/** Runner variant that exposes the worker-thread composition readiness signal. */
interface ReadinessAwareWorkflowRunner extends IWorkflowRunner {
  /** Run once and separately expose the worker's post-composition readiness. */
  runWithReadiness(
    config: WorkerNodeProvisionRequest['workerConfig'],
    signal: AbortSignal,
    manifest?: WorkerNodeProvisionRequest['workerManifest'],
  ): ThinWorkflowPiscinaRunWithReadiness;
}

/**
 * Check whether a runner exposes the Piscina worker composition readiness seam.
 * @param runner - Configured workflow runner.
 * @returns Whether the runner emits worker-thread readiness separately.
 */
function isReadinessAwareWorkflowRunner(runner: IWorkflowRunner): runner is ReadinessAwareWorkflowRunner {
  return 'runWithReadiness' in runner && typeof runner.runWithReadiness === 'function';
}

/**
 * Built-in thin workflow provider backed by the existing workflow-level
 * Piscina runner.
 *
 * This provider wraps an {@link IWorkflowRunner} so it can be registered
 * with the framework capability registry and participate in pool-driven
 * dispatch. Each {@link provision} call starts the underlying runner and
 * returns a validated {@link ProviderAllocationRef} together with an
 * infrastructure-only {@link WorkerNodeHandle}.
 *
 * The handle controls allocation lifecycle (cancel/terminate) but does
 * NOT expose readiness or workflow results. Readiness is signaled via
 * the worker protocol (`control.attempt-ready` bus subject) after runtime
 * composition. Workflow outcomes are submitted and acknowledged through
 * the Authority's `control.outcome.submit` bus subject.
 *
 * Piscina is a local thin workflow runner: it declares that it is NOT
 * recoverable. Allocation references are process-local and non-durable.
 */
export class PiscinaThinWorkflowProvider implements IWorkerNodeProvider {
  /** Execution environment tag used for pool provider matching. */
  public readonly environment = 'piscina' as const;
  /** Capabilities advertised to the pool dispatch selector. */
  public readonly baseCapabilities: NormalizedWorkerNodeCapabilities;

  /**
   * @param options - Provider identity, runner, and optional capability overrides.
   */
  public constructor(private readonly options: PiscinaThinWorkflowProviderOptions) {
    this.baseCapabilities = WorkerNodeCapabilitiesSchema.parse({
      ...DEFAULT_BASE_CAPABILITIES,
      ...options.baseCapabilities,
      suspensionStrategy: options.baseCapabilities?.suspensionStrategy ?? DEFAULT_BASE_CAPABILITIES.suspensionStrategy,
    });
  }

  /** @returns Unique identifier for this provider instance. */
  public get id(): string {
    return this.options.id;
  }

  /** @returns Human-readable display name for this provider. */
  public get displayName(): string {
    return this.options.displayName;
  }

  /**
   * Provision a new local execution allocation for the given workflow
   * request.
   *
   * Starts the underlying runner and returns a validated allocation
   * reference together with an infrastructure-only handle. The handle
   * controls allocation lifecycle (cancel/terminate) via an internal
   * {@link AbortController} wired to the runner's signal.
   *
   * Cooperative cancellation: if the caller's `signal` is already
   * aborted, or becomes aborted before the runner starts, the provision
   * rejects without starting the runner.
   * @param request - Full provision request containing worker config and manifest.
   * @param signal - AbortSignal for cooperative cancellation of the provision operation.
   * @returns Validated allocation reference and infrastructure handle.
   */
  public async provision(request: WorkerNodeProvisionRequest, signal: AbortSignal): Promise<WorkerNodeProvisionResult> {
    if (signal.aborted) {
      throw new Error(
        signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'Provision aborted'),
      );
    }

    const controller = new AbortController();
    const infrastructureConclusionObservers = new Set<(conclusion: { readonly message: string }) => void>();
    let infrastructureConclusion: { readonly message: string } | undefined;
    const concludeInfrastructure = (message: string): void => {
      if (infrastructureConclusion !== undefined) return;
      infrastructureConclusion = { message };
      for (const observer of infrastructureConclusionObservers) observer(infrastructureConclusion);
      infrastructureConclusionObservers.clear();
    };

    // Forward caller signal abort to the internal controller so cancel
    // propagates from both the handle and the caller's signal.
    const onCallerAbort = (): void => {
      controller.abort(signal.reason);
    };
    signal.addEventListener('abort', onCallerAbort, { once: true });

    // Start the runner and submit the outcome through the Authority bus
    // protocol when it settles. The submission is fire-and-forget from the
    // provider's perspective — the Authority owns durable convergence.
    const run = this.options.runner;
    let resultPromise: Promise<WorkflowRunResult>;
    if (isReadinessAwareWorkflowRunner(run)) {
      const dispatch = run.runWithReadiness(request.workerConfig, controller.signal, request.workerManifest);
      resultPromise = dispatch.result;
      void dispatch.ready
        .then(
          async (ready) => {
            if (!controller.signal.aborted) {
              await this.options.bus.emit(WorkerNodeSubjects.control['attempt-ready'], {
                executionAttemptId: request.executionAttemptId,
                executionId: request.executionId,
                adapters: [...ready.adapters],
              });
            }
          },
          () => undefined,
        )
        .catch((error: unknown) => controller.abort(error));
    } else {
      resultPromise = run
        .run(request.workerConfig, controller.signal, request.workerManifest)
        .then((completion) => completion.result);
    }

    void this.submitOutcomeOnSettlement(
      resultPromise,
      request.executionId,
      request.executionAttemptId,
      request.workerConfig.workflowId,
      concludeInfrastructure,
    );

    // Build and validate a process-local allocation reference.
    const allocationRef = this.buildAllocationRef(request.executionAttemptId);

    return {
      allocationRef,
      handle: {
        executionAttemptId: request.executionAttemptId,
        /**
         * Request graceful cancellation of the running execution.
         * @param reason - Optional human-readable cancellation reason.
         * @returns Promise that resolves when cancellation has been dispatched.
         */
        cancel: (reason?: string): Promise<void> => {
          controller.abort(reason ?? 'WorkerNode cancelled');
          signal.removeEventListener('abort', onCallerAbort);
          return Promise.resolve();
        },
        /**
         * Forcibly terminate the execution environment.
         * @returns Promise that resolves when termination has been dispatched.
         */
        terminate: (): Promise<void> => {
          controller.abort('WorkerNode terminated');
          signal.removeEventListener('abort', onCallerAbort);
          return Promise.resolve();
        },
        /**
         * Release provider resources for this allocation.
         *
         * For the local Piscina provider this is a no-op: the only
         * per-allocation resource is the caller abort listener, which is
         * removed here for symmetry. The runner and abort controller are
         * intentionally left untouched.
         * @returns Promise that resolves immediately.
         */
        release: (): Promise<void> => {
          signal.removeEventListener('abort', onCallerAbort);
          return Promise.resolve();
        },
        observeInfrastructureConclusion: (observer): (() => void) => {
          if (infrastructureConclusion !== undefined) {
            observer(infrastructureConclusion);
            return () => undefined;
          }
          infrastructureConclusionObservers.add(observer);
          return () => infrastructureConclusionObservers.delete(observer);
        },
      },
    };
  }

  /**
   * Submit a workflow outcome through the Authority bus protocol after
   * the runner promise settles.
   *
   * On success, submits the runner's result directly. On failure, builds
   * a `failed` {@link WorkflowRunResult} from the error message.
   *
   * Uses the shared {@link submitOutcomeWithAck} helper for decision-aware
   * retry with bounded exponential back-off. Since the Piscina provider
   * runs in-process, a persistently failing local submit means the outcome
   * handler is unregistered — an infrastructure failure that the host recovery
   * coordinator reconciles via recovery operations.
   * @param resultPromise - Promise resolving to the workflow run result.
   * @param executionId - Workflow execution identifier.
   * @param executionAttemptId - Authority-created attempt identifier.
   * @param workflowId - Workflow definition identifier.
   * @param onInfrastructureConclusion - Reports failed durable outcome delivery as terminal infrastructure evidence.
   */
  private async submitOutcomeOnSettlement(
    resultPromise: Promise<WorkflowRunResult>,
    executionId: string,
    executionAttemptId: string,
    workflowId: string,
    onInfrastructureConclusion: (message: string) => void,
  ): Promise<void> {
    let result: WorkflowRunResult;
    try {
      result = await resultPromise;
    } catch (error) {
      result = {
        executionId,
        workflowId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const retryConfig = {
        ...PISCINA_OUTCOME_RETRY_DEFAULTS,
        ...this.options.outcomeRetry,
      };
      await submitOutcomeWithAck(
        this.options.bus,
        {
          executionAttemptId,
          executionId,
          result,
        },
        { retry: retryConfig },
      );
    } catch (submitError) {
      // Non-transient rejections (conflict/fenced) are OutcomeDeliveryErrors.
      // Transient exhaustion or infrastructure failures are logged so the
      // waiter does not hang silently — the host recovery coordinator reconciles it.
      if (submitError instanceof OutcomeDeliveryError) {
        console.error(
          `[PiscinaThinWorkflowProvider] Outcome rejected for ` +
            `execution '${executionId}' attempt '${executionAttemptId}' ` +
            `(decision=${submitError.decision}):`,
          submitError,
        );
      } else {
        console.error(
          `[PiscinaThinWorkflowProvider] Failed to submit outcome for ` +
            `execution '${executionId}' attempt '${executionAttemptId}':`,
          submitError,
        );
      }
      onInfrastructureConclusion(
        `Piscina worker ended without an acknowledged outcome: ` +
          (submitError instanceof Error ? submitError.message : String(submitError)),
      );
    }
  }

  /**
   * Build a process-local allocation reference validated by this
   * provider's codec.
   *
   * The `providerData` carries the execution attempt ID and a monotonic
   * timestamp for correlation/diagnostics. The reference is validated
   * against {@link ProviderAllocationRefSchema} before return.
   * @param executionAttemptId - Authority-created attempt identifier.
   * @returns Validated, versioned allocation reference.
   */
  private buildAllocationRef(executionAttemptId: string): ProviderAllocationRef {
    const ref: ProviderAllocationRef = {
      version: PROVIDER_ALLOCATION_REF_VERSION,
      providerId: BUILT_IN_THIN_WORKFLOW_PROVIDER_ID,
      providerData: {
        executionAttemptId,
        allocatedAt: Date.now(),
      },
    };
    return ProviderAllocationRefSchema.parse(ref);
  }
}
