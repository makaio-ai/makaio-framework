import type { IMakaioBus } from '@makaio/bus-core';
import type {
  IWorkerNodeProvider,
  IWorkflowRunner,
  NormalizedWorkerNodeCapabilities,
  ProviderAllocationRef,
  WorkerNodeAllocatedOutcome,
  WorkerNodeCapabilities,
  WorkerNodeHandle,
  WorkerNodeInfrastructureConclusion,
  WorkerNodeProvisionRequest,
  WorkflowRunResult,
} from '@makaio/contracts';
import {
  BoundedRecoveryEvidenceSchema,
  PROVIDER_ALLOCATION_REF_VERSION,
  ProviderAllocationRefSchema,
  RECOVERY_EVIDENCE_LIMITS,
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
   * {@link ReadinessAwareWorkflowRunner} implementation is accepted so tests
   * can supply lightweight fakes without spawning real worker threads.
   *
   * Readiness is part of the requirement rather than an optional refinement:
   * this provider publishes `control.attempt-ready` from the runner's
   * post-composition signal, and a runner without one would silently never
   * make an attempt ready instead of failing where it is wired.
   */
  readonly runner: ReadinessAwareWorkflowRunner;
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
   *
   * `supportsRecovery` is omitted from this type rather than accepted and
   * discarded. It is fixed by the allocation lifetime, so a host that sets it
   * is stating something untrue about this provider and should be told at the
   * call site instead of having the value silently dropped. See
   * {@link PiscinaThinWorkflowProvider}.
   */
  readonly baseCapabilities?: Omit<Partial<WorkerNodeCapabilities>, 'supportsRecovery'>;
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

/**
 * Runner variant that exposes the worker-thread composition readiness signal.
 *
 * Extends {@link IWorkflowRunner} because a readiness-aware runner is still a
 * workflow runner; this provider only ever drives it through
 * {@link runWithReadiness}, which is the sole path that can report an attempt
 * as ready.
 */
export interface ReadinessAwareWorkflowRunner extends IWorkflowRunner {
  /**
   * Run once and separately expose the worker's post-composition readiness.
   * @param config - Worker configuration for the run.
   * @param signal - AbortSignal that cancels the run.
   * @param manifest - Optional per-call contribution manifest.
   * @returns Terminal result promise and post-composition readiness promise.
   */
  runWithReadiness(
    config: WorkerNodeProvisionRequest['workerConfig'],
    signal: AbortSignal,
    manifest?: WorkerNodeProvisionRequest['workerManifest'],
  ): ThinWorkflowPiscinaRunWithReadiness;
}

/**
 * At-most-once terminal infrastructure conclusion with replay for late observers.
 */
interface InfrastructureConclusionSignal {
  /** Record the first terminal conclusion and notify every current observer. */
  readonly conclude: (summary: string) => void;
  /** Observe the conclusion, replaying it synchronously when it already happened. */
  readonly observe: (observer: (conclusion: WorkerNodeInfrastructureConclusion) => void) => () => void;
}

/**
 * Create a single-shot terminal infrastructure conclusion signal.
 *
 * The first conclusion wins and is retained, so observers registered after it
 * receive the same conclusion synchronously. Each observer is notified at most
 * once, matching the {@link WorkerNodeHandle.observeInfrastructureConclusion}
 * contract.
 *
 * The summary is validated through the contract's own evidence schema here,
 * rather than trusted at the observer, because an observer that ends the
 * allocation has to persist it.
 * @param source - Provider instance recorded as the observer of the evidence.
 * @returns Conclusion reporter and observer registration.
 */
function createInfrastructureConclusionSignal(source: string): InfrastructureConclusionSignal {
  const observers = new Set<(conclusion: WorkerNodeInfrastructureConclusion) => void>();
  let conclusion: WorkerNodeInfrastructureConclusion | undefined;

  return {
    conclude: (summary: string): void => {
      if (conclusion !== undefined) return;
      conclusion = {
        evidence: BoundedRecoveryEvidenceSchema.parse({
          source: source.slice(0, RECOVERY_EVIDENCE_LIMITS.source),
          summary: summary.slice(0, RECOVERY_EVIDENCE_LIMITS.summary),
          observedAt: new Date().toISOString(),
        }),
      };
      const pending = [...observers];
      observers.clear();
      for (const observer of pending) {
        try {
          observer(conclusion);
        } catch (error) {
          console.error('[PiscinaThinWorkflowProvider] Infrastructure-conclusion observer failed:', error);
        }
      }
    },
    observe: (observer): (() => void) => {
      if (conclusion !== undefined) {
        observer(conclusion);
        return () => undefined;
      }
      observers.add(observer);
      return () => observers.delete(observer);
    },
  };
}

/**
 * Infrastructure-only handle for one local worker-thread allocation.
 *
 * The handle outlives the provision call that created it — it is held until
 * the workflow outcome settles — so it deliberately holds only what allocation
 * control needs: the attempt identifier, the controller wired to the runner,
 * the caller-abort forwarder, and the conclusion signal. A handle assembled as
 * closures inside `provision` would instead share that call's scope and keep
 * the whole provision request reachable, including the worker configuration
 * with its trigger payload and the contribution manifest.
 */
class PiscinaAllocationHandle implements WorkerNodeHandle {
  /**
   * @param executionAttemptId - Authority-created attempt identifier for this allocation.
   * @param controller - Controller wired to the runner's cancellation signal.
   * @param detachCallerAbort - Removes this allocation's forwarder from the caller's signal.
   * @param infrastructure - Single-shot terminal infrastructure conclusion signal.
   */
  public constructor(
    public readonly executionAttemptId: string,
    private readonly controller: AbortController,
    private readonly detachCallerAbort: () => void,
    private readonly infrastructure: InfrastructureConclusionSignal,
  ) {}

  /**
   * Request graceful cancellation of the running execution.
   * @param reason - Optional human-readable cancellation reason.
   * @returns Promise that resolves when cancellation has been dispatched.
   */
  public cancel(reason?: string): Promise<void> {
    this.controller.abort(reason ?? 'WorkerNode cancelled');
    this.detachCallerAbort();
    return Promise.resolve();
  }

  /**
   * Forcibly terminate the execution environment.
   * @returns Promise that resolves when termination has been dispatched.
   */
  public terminate(): Promise<void> {
    this.controller.abort('WorkerNode terminated');
    this.detachCallerAbort();
    return Promise.resolve();
  }

  /**
   * Release provider resources for this allocation.
   *
   * For the local Piscina provider this is a no-op beyond detaching the caller
   * abort listener, which is the only per-allocation resource. The runner and
   * abort controller are intentionally left untouched.
   * @returns Promise that resolves immediately.
   */
  public release(): Promise<void> {
    this.detachCallerAbort();
    return Promise.resolve();
  }

  /**
   * Observe definite terminal infrastructure evidence for this allocation.
   * @param observer - Callback invoked at most once for a terminal conclusion.
   * @returns Cleanup function that stops observing the provider signal.
   */
  public observeInfrastructureConclusion(
    observer: (conclusion: WorkerNodeInfrastructureConclusion) => void,
  ): () => void {
    return this.infrastructure.observe(observer);
  }
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
 *
 * That declaration is a consequence of the allocation lifetime, not a
 * configuration choice. Worker threads cannot outlive the process that
 * provisioned them, so there is no allocation left to discover, attach to, or
 * converge once that process is gone. The provider therefore implements no
 * recovery capability, and `supportsRecovery` stays `false` regardless of the
 * capability overrides a host supplies.
 */
export class PiscinaThinWorkflowProvider implements IWorkerNodeProvider {
  /** Execution environment tag used for pool provider matching. */
  public readonly environment = 'piscina' as const;
  /**
   * Allocations are worker threads inside the provisioning process.
   *
   * When that process is gone the threads are gone with it, so there is
   * nothing to rediscover or converge in provider infrastructure.
   */
  public readonly allocationLifetime = 'provisioner-process-bound' as const;
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
      // Pinned after the overrides: advertising recovery would offer dispatch
      // selectors a capability this provider does not implement and its
      // allocation lifetime cannot support. Typed callers are rejected at the
      // call site by the option type; this pin holds the line for callers with
      // no types to reject them.
      supportsRecovery: false,
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
   * rejects with the signal's own abort reason without starting the
   * runner. Cancellation is never flattened into an outcome, so callers
   * can tell it apart from an ambiguous infrastructure rejection.
   *
   * The return type is narrower than {@link IWorkerNodeProvider.provision}:
   * this provider allocates a local worker thread or rejects, and it has no
   * way to positively prove that nothing was created. The narrow type states
   * what it can prove today. Gaining the ability to confirm absence means
   * deliberately widening this signature back to the contract union.
   * @param request - Full provision request containing worker config and manifest.
   * @param signal - AbortSignal for cooperative cancellation of the provision operation.
   * @returns Allocated outcome with a validated allocation reference and infrastructure handle.
   */
  public async provision(
    request: WorkerNodeProvisionRequest,
    signal: AbortSignal,
  ): Promise<WorkerNodeAllocatedOutcome> {
    signal.throwIfAborted();

    const controller = new AbortController();
    const infrastructure = createInfrastructureConclusionSignal(this.id);

    // Forward caller signal abort to the internal controller so cancel
    // propagates from both the handle and the caller's signal.
    const onCallerAbort = (): void => {
      controller.abort(signal.reason);
    };
    signal.addEventListener('abort', onCallerAbort, { once: true });
    // The forwarder is owned by the returned handle. Every path that ends this
    // provider's interest in the caller's signal detaches it through here.
    const detachCallerAbort = (): void => signal.removeEventListener('abort', onCallerAbort);

    try {
      // Construct the complete allocation response before the runner can
      // settle. A rejected provision must never leave a runner that can submit
      // an outcome for an allocation the caller could not record.
      const { executionAttemptId, executionId, workerConfig } = request;
      const allocationRef = this.buildAllocationRef(executionAttemptId);
      const handle = new PiscinaAllocationHandle(executionAttemptId, controller, detachCallerAbort, infrastructure);

      // The caller can abort after the entry check but before the forwarder is
      // attached. Re-check at the last synchronous boundary before startup so
      // no runner exists for an allocation the caller never received.
      signal.throwIfAborted();

      // Start the runner and submit the outcome through the Authority bus
      // protocol when it settles. The submission is fire-and-forget from the
      // provider's perspective — the Authority owns durable convergence.
      const dispatch = this.options.runner.runWithReadiness(
        request.workerConfig,
        controller.signal,
        request.workerManifest,
      );
      void dispatch.ready
        .then(
          async (ready) => {
            if (!controller.signal.aborted) {
              await this.options.bus.emit(WorkerNodeSubjects.control['attempt-ready'], {
                executionAttemptId,
                executionId,
                adapters: [...ready.adapters],
              });
            }
          },
          () => undefined,
        )
        .catch((error: unknown) => controller.abort(error));

      void this.submitOutcomeOnSettlement(
        dispatch.result,
        executionId,
        executionAttemptId,
        workerConfig.workflowId,
        infrastructure.conclude,
      );

      return {
        kind: 'allocated',
        allocationRef,
        handle,
      };
    } catch (error) {
      // No handle reaches the caller on this path, so no later lifecycle owner
      // can stop a runner that did start or detach the caller forwarder.
      controller.abort(error);
      detachCallerAbort();
      throw error;
    }
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
    onInfrastructureConclusion: (summary: string) => void,
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
      // The failure itself is logged above and stays there. The conclusion is
      // durable evidence for whoever ends the allocation on it, so it states
      // what this provider observed rather than repeating a message that came
      // from wherever the submission failed.
      onInfrastructureConclusion(
        `Piscina worker for attempt '${executionAttemptId}' ended without an acknowledged outcome ` +
          `because outcome submission could not be completed`,
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
   *
   * The reference names this provider *instance*, not the built-in identifier
   * this class is usually registered under. A reference identifies who created
   * the allocation, and an attempt is bound to the instance that provisioned
   * it, so a second instance stamping the built-in identifier would describe
   * its allocations as another provider's.
   * @param executionAttemptId - Authority-created attempt identifier.
   * @returns Validated, versioned allocation reference.
   */
  private buildAllocationRef(executionAttemptId: string): ProviderAllocationRef {
    const ref: ProviderAllocationRef = {
      version: PROVIDER_ALLOCATION_REF_VERSION,
      providerId: this.id,
      providerData: {
        executionAttemptId,
        allocatedAt: Date.now(),
      },
    };
    return ProviderAllocationRefSchema.parse(ref);
  }
}
