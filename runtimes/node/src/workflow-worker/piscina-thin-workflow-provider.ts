import type { IMakaioBus } from '@makaio/bus-core';
import type {
  IWorkerProvider,
  IWorkflowRunner,
  NormalizedWorkerCapabilities,
  ProviderAllocationRef,
  WorkerAllocatedOutcome,
  BoundedRecoveryEvidence,
  WorkerCapabilities,
  WorkerHandle,
  WorkerInfrastructureConclusion,
  WorkerProvisionRequest,
  WorkflowRunResult,
} from '@makaio/contracts';
import {
  BoundedRecoveryEvidenceSchema,
  PROVIDER_ALLOCATION_REF_VERSION,
  ProviderAllocationRefSchema,
  RECOVERY_EVIDENCE_LIMITS,
  WorkerCapabilitiesSchema,
} from '@makaio/contracts';
import { mintOrRotateWorkflowExecutionBusSecret } from '../workflow-execution-bus-access.js';
import { OutcomeDeliveryError, submitOutcomeWithAck, type OutcomeSubmitRetryConfig } from './outcome-submission.js';
import type {
  ThinWorkflowPiscinaAttemptBinding,
  ThinWorkflowPiscinaRunWithReadiness,
} from './thin-workflow-piscina-runner.js';

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
   * the thread's own registration is what makes the attempt ready, and this
   * provider watches that signal to abort the allocation when it fails. A
   * runner without one would silently swallow a refused registration instead
   * of failing where it is wired.
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
  readonly baseCapabilities?: Omit<Partial<WorkerCapabilities>, 'supportsRecovery'>;
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

const DEFAULT_BASE_CAPABILITIES: NormalizedWorkerCapabilities = {
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
   * Run once and separately expose the worker's own registration readiness.
   * @param config - Worker configuration for the run.
   * @param signal - AbortSignal that cancels the run.
   * @param manifest - Optional per-call contribution manifest.
   * @param attempt - Attempt identity the dispatched worker registers against.
   * @returns Terminal result promise and registration readiness promise.
   */
  runWithReadiness(
    config: WorkerProvisionRequest['workerConfig'],
    signal: AbortSignal,
    manifest: WorkerProvisionRequest['workerManifest'] | undefined,
    attempt: ThinWorkflowPiscinaAttemptBinding,
  ): ThinWorkflowPiscinaRunWithReadiness;
}

/**
 * At-most-once terminal infrastructure conclusion with replay for late observers.
 */
interface InfrastructureConclusionSignal {
  /** Record the first terminal conclusion and notify every current observer. */
  readonly conclude: (summary: string) => void;
  /** Observe the conclusion, replaying it synchronously when it already happened. */
  readonly observe: (observer: (conclusion: WorkerInfrastructureConclusion) => void) => () => void;
}

/**
 * At-most-once positive provider-completion proof with replay for late observers.
 */
interface ProviderCompletionSignal {
  /** Record the first positive completion proof and notify every current observer. */
  readonly complete: (observation: ProviderCompletionObservation) => void;
  /** Observe the completion proof, replaying it synchronously when it already happened. */
  readonly observe: (observer: (evidence: BoundedRecoveryEvidence) => void) => () => void;
}

/** Bounded provider-owned fact establishing that Piscina has no remaining allocation duties. */
interface ProviderCompletionObservation {
  /** Stable classification of the observed provider completion. */
  readonly code: string;
  /** Non-secret explanation of the completed provider responsibility. */
  readonly summary: string;
}

const OUTCOME_ACKNOWLEDGED_COMPLETION: ProviderCompletionObservation = {
  code: 'outcome-acknowledged',
  summary: 'Piscina runner settled and the Authority acknowledged its workflow outcome',
};

const OUTCOME_DELIVERY_ENDED_COMPLETION: ProviderCompletionObservation = {
  code: 'outcome-delivery-ended',
  summary: 'Piscina runner settled and its bounded workflow outcome delivery ended',
};

/** At-most-once report that this handle can no longer observe an open operation. */
interface LocalObservationLossSignal {
  /** Report permanent loss of this handle's local observation. */
  readonly lose: () => void;
  /** Observe the loss, replaying it synchronously when it already happened. */
  readonly observe: (observer: () => void) => () => void;
}

/** Mutually exclusive final observations a Piscina allocation can make. */
interface TerminalObservationSignals {
  /** Positive completion proof, when the Authority acknowledged the outcome. */
  readonly completion: ProviderCompletionSignal;
  /** Loss of local observation when positive completion is impossible. */
  readonly localObservationLoss: LocalObservationLossSignal;
}

/** Private retained value signal shared by the provider's two terminal fact families. */
interface ReplayOnceSignal<T extends object> {
  /** Publish the retained value at most once. */
  readonly publish: (createValue: () => T) => void;
  /** Observe the retained value, replaying it after publication. */
  readonly observe: (observer: (value: T) => void) => () => void;
}

/**
 * Create an at-most-once signal that replays its retained value to late observers.
 *
 * The value producer runs before the signal becomes observable. Callers can
 * therefore perform required local cleanup in the producer without exposing
 * a completion or conclusion before that cleanup succeeds.
 * @param observerFailureLabel - Stable log prefix identifying the signal's observer family.
 * @returns Publisher and observer registration for one retained value.
 */
function createReplayOnceSignal<T extends object>(observerFailureLabel: string): ReplayOnceSignal<T> {
  const observers = new Set<(value: T) => void>();
  let value: T | undefined;

  return {
    publish: (createValue): void => {
      if (value !== undefined) return;
      const nextValue = createValue();
      value = nextValue;
      const pending = [...observers];
      observers.clear();
      for (const observer of pending) {
        try {
          observer(nextValue);
        } catch (error) {
          console.error(`${observerFailureLabel} observer failed:`, error);
        }
      }
    },
    observe: (observer): (() => void) => {
      if (value !== undefined) {
        observer(value);
        return () => undefined;
      }
      observers.add(observer);
      return () => observers.delete(observer);
    },
  };
}

/**
 * Create a single-shot terminal infrastructure conclusion signal.
 *
 * The first conclusion wins and is retained, so observers registered after it
 * receive the same conclusion synchronously. Each observer is notified at most
 * once, matching the {@link WorkerHandle.observeInfrastructureConclusion}
 * contract.
 *
 * The summary is validated through the contract's own evidence schema here,
 * rather than trusted at the observer, because an observer that ends the
 * allocation has to persist it.
 * @param source - Provider instance recorded as the observer of the evidence.
 * @returns Conclusion reporter and observer registration.
 */
function createInfrastructureConclusionSignal(source: string): InfrastructureConclusionSignal {
  const signal = createReplayOnceSignal<WorkerInfrastructureConclusion>(
    '[PiscinaThinWorkflowProvider] Infrastructure-conclusion',
  );

  return {
    conclude: (summary: string): void => {
      signal.publish(() => ({
        evidence: BoundedRecoveryEvidenceSchema.parse({
          source: source.slice(0, RECOVERY_EVIDENCE_LIMITS.source),
          summary: summary.slice(0, RECOVERY_EVIDENCE_LIMITS.summary),
          observedAt: new Date().toISOString(),
        }),
      }));
    },
    observe: signal.observe,
  };
}

/**
 * Create mutually exclusive final observation signals for one allocation.
 *
 * Piscina can prove provider completion once its admitted runner and bounded
 * local outcome-delivery path both settled; Authority acknowledgement and
 * exhausted delivery produce distinct evidence. When no admitted runner can
 * be observed to settle, it reports loss of local observation instead. The two
 * reports cannot both be true.
 * @param source - Provider instance recorded as the observer of the evidence.
 * @param releaseBusIdentity - Releases the attempt identity once no future outcome can use it.
 * @returns Completion and local-observation-loss reporters with their observers.
 */
function createTerminalObservationSignals(source: string, releaseBusIdentity: () => void): TerminalObservationSignals {
  const completionSignal = createReplayOnceSignal<BoundedRecoveryEvidence>(
    '[PiscinaThinWorkflowProvider] Provider-completion',
  );
  const localObservationLossSignal = createReplayOnceSignal<Record<never, never>>(
    '[PiscinaThinWorkflowProvider] Local-observation-loss',
  );
  let finalObservation: 'completion' | 'local-observation-loss' | undefined;

  return {
    completion: {
      complete: (observation): void => {
        if (finalObservation !== undefined) return;
        completionSignal.publish(() => {
          const completionEvidence = BoundedRecoveryEvidenceSchema.parse({
            source: source.slice(0, RECOVERY_EVIDENCE_LIMITS.source),
            code: observation.code,
            summary: observation.summary,
            observedAt: new Date().toISOString(),
          });
          releaseBusIdentity();
          finalObservation = 'completion';
          return completionEvidence;
        });
      },
      observe: completionSignal.observe,
    },
    localObservationLoss: {
      lose: (): void => {
        if (finalObservation !== undefined) return;
        localObservationLossSignal.publish(() => {
          finalObservation = 'local-observation-loss';
          return {};
        });
      },
      observe: (observer): (() => void) => localObservationLossSignal.observe(() => observer()),
    },
  };
}

/**
 * Infrastructure-only handle for one local worker-thread allocation.
 *
 * The handle outlives the provision call that created it — it is held until
 * the workflow outcome settles — so it deliberately holds only what allocation
 * control needs: the attempt identifier, the controller wired to the runner,
 * the caller-abort forwarder, and terminal/completion signals. A handle
 * assembled as closures inside `provision` would instead share that call's
 * scope and keep the whole provision request reachable, including the worker
 * configuration with its trigger payload and the contribution manifest.
 */
class PiscinaAllocationHandle implements WorkerHandle {
  /**
   * @param executionAttemptId - Authority-created attempt identifier for this allocation.
   * @param controller - Controller wired to the runner's cancellation signal.
   * @param detachCallerAbort - Removes this allocation's forwarder from the caller's signal.
   * @param infrastructure - Single-shot terminal infrastructure conclusion signal.
   * @param completion - Single-shot positive provider completion signal.
   * @param localObservationLoss - Single-shot signal that this handle can no longer observe an open operation.
   * @param revokeBusIdentity - Unregisters the attempt-scoped bus secret minted for this allocation.
   */
  public constructor(
    public readonly executionAttemptId: string,
    private readonly controller: AbortController,
    private readonly detachCallerAbort: () => void,
    private readonly infrastructure: InfrastructureConclusionSignal,
    private readonly completion: ProviderCompletionSignal,
    private readonly localObservationLoss: LocalObservationLossSignal,
    private readonly revokeBusIdentity: () => void,
  ) {}

  /**
   * Request graceful cancellation of the running execution.
   * @param reason - Optional human-readable cancellation reason.
   * @returns Promise that resolves when cancellation has been dispatched.
   */
  public cancel(reason?: string): Promise<void> {
    // The bus identity survives a cancel: the thread is still connected and
    // still owes the Authority its outcome, and fencing its socket here would
    // turn a cooperative cancellation into a lost result.
    this.controller.abort(reason ?? 'Worker cancelled');
    this.detachCallerAbort();
    return Promise.resolve();
  }

  /**
   * Forcibly terminate the execution environment.
   * @returns Promise that resolves when termination has been dispatched.
   */
  public terminate(): Promise<void> {
    this.controller.abort('Worker terminated');
    this.detachCallerAbort();
    this.revokeBusIdentity();
    return Promise.resolve();
  }

  /**
   * Release provider resources for this allocation.
   *
   * Release only detaches the caller's abort forwarder. It may run while the
   * worker thread or its outcome acknowledgement is still pending, so it must
   * not revoke the attempt-scoped bus identity: the thread still needs that
   * identity to report its outcome. Final identity cleanup belongs to positive
   * provider completion or an explicit terminal path instead.
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
  public observeInfrastructureConclusion(observer: (conclusion: WorkerInfrastructureConclusion) => void): () => void {
    return this.infrastructure.observe(observer);
  }

  /**
   * Observe proof that this provider has no remaining allocation duties.
   * @param observer - Callback invoked at most once after runner settlement and outcome acknowledgement.
   * @returns Cleanup function that stops observing the provider signal.
   */
  public observeProviderCompletion(observer: (evidence: BoundedRecoveryEvidence) => void): () => void {
    return this.completion.observe(observer);
  }

  /**
   * Observe permanent loss of this handle's local monitoring.
   * @param observer - Callback invoked at most once after local observation is lost.
   * @returns Cleanup function that stops observing the provider signal.
   */
  public observeLocalObservationLoss(observer: () => void): () => void {
    return this.localObservationLoss.observe(observer);
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
 * infrastructure-only {@link WorkerHandle}.
 *
 * The handle controls allocation lifecycle (cancel/terminate) but does
 * NOT expose readiness or workflow results. Readiness is the worker thread's
 * own business: it registers its runtime with the ExecutionAttempt authority,
 * which publishes `execution-attempt.runtime.ready`. Workflow outcomes are
 * submitted and acknowledged through the Authority's `control.outcome.submit`
 * bus subject.
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
export class PiscinaThinWorkflowProvider implements IWorkerProvider {
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
  public readonly baseCapabilities: NormalizedWorkerCapabilities;

  /**
   * @param options - Provider identity, runner, and optional capability overrides.
   */
  public constructor(private readonly options: PiscinaThinWorkflowProviderOptions) {
    this.baseCapabilities = WorkerCapabilitiesSchema.parse({
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
   * The return type is narrower than {@link IWorkerProvider.provision}:
   * this provider allocates a local worker thread or rejects, and it has no
   * way to positively prove that nothing was created. The narrow type states
   * what it can prove today. Gaining the ability to confirm absence means
   * deliberately widening this signature back to the contract union.
   * A worker configuration without a bus URL is rejected loudly rather than
   * allocated: the thread would have no transport, so it could never
   * authenticate as the attempt or register its runtime, and the allocation
   * would be a worker that is provisioned and permanently unready.
   * @param request - Full provision request containing worker config and manifest.
   * @param signal - AbortSignal for cooperative cancellation of the provision operation.
   * @returns Allocated outcome with a validated allocation reference and infrastructure handle.
   * @throws When the worker configuration carries no bus URL.
   */
  public async provision(request: WorkerProvisionRequest, signal: AbortSignal): Promise<WorkerAllocatedOutcome> {
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
    // Set once the attempt-scoped identity exists. A provision that rejects
    // after minting must not leave a registered identity behind, so the failure
    // path below gives it up again.
    let revokeBusIdentity: (() => void) | undefined;

    try {
      // Construct the complete allocation response before the runner can
      // settle. A rejected provision must never leave a runner that can submit
      // an outcome for an allocation the caller could not record.
      const { executionAttemptId, executionId, workerConfig } = request;
      if (!workerConfig.busUrl) {
        // A thread with no transport cannot hold an authenticated, fenced
        // control endpoint, so it can never register its runtime with the
        // attempt. Failing here is the honest answer; allocating it would
        // produce a worker that is provisioned but permanently unready.
        throw new Error(
          `PiscinaThinWorkflowProvider requires a bus URL to provision an execution attempt ` +
            `(executionAttemptId=${executionAttemptId}, executionId=${executionId})`,
        );
      }
      const allocationRef = this.buildAllocationRef(executionAttemptId);
      // The thread authenticates as the attempt, not as this process: the
      // registration and admission gates take the caller's identity from the
      // authenticated transport peer. Same move a remote provider makes when
      // it mints the bootstrap credentials its container connects with.
      const busIdentity = mintOrRotateWorkflowExecutionBusSecret({ executionAttemptId, executionId });
      let busIdentityReleased = false;
      const releaseBusIdentity = (): void => {
        if (busIdentityReleased) return;
        busIdentityReleased = true;
        busIdentity.cleanup();
      };
      revokeBusIdentity = releaseBusIdentity;
      const terminalObservations = createTerminalObservationSignals(this.id, releaseBusIdentity);
      const handle = new PiscinaAllocationHandle(
        executionAttemptId,
        controller,
        detachCallerAbort,
        infrastructure,
        terminalObservations.completion,
        terminalObservations.localObservationLoss,
        releaseBusIdentity,
      );

      // The caller can abort after the entry check but before the forwarder is
      // attached. Re-check at the last synchronous boundary before startup so
      // no runner exists for an allocation the caller never received.
      signal.throwIfAborted();

      // Start the runner and submit the outcome through the Authority bus
      // protocol when it settles. The submission is fire-and-forget from the
      // provider's perspective — the Authority owns durable convergence.
      const dispatch = this.options.runner.runWithReadiness(
        { ...workerConfig, busAuth: { kind: 'hmac', secret: busIdentity.secret } },
        controller.signal,
        request.workerManifest,
        { executionAttemptId, bootstrapDeadlineAt: request.bootstrapDeadlineAt },
      );
      // Readiness is the Authority's own published fact now, so nothing is
      // emitted here. What the provider owns is how the thread ends. Admitted:
      // its terminal result is the attempt's workflow outcome. Refused before
      // admission (registration refused, probe failed, allocation never
      // visible): no workflow ran, so the thread's rejection is not an outcome
      // and must not be submitted as one — the Authority would settle the
      // attempt as a workflow failure instead of letting infrastructure
      // convergence reconcile it. That refusal aborts the allocation and is
      // reported as terminal infrastructure evidence, the way a dead worker is.
      void dispatch.ready.then(
        () =>
          this.submitOutcomeOnSettlement(
            dispatch.result,
            executionId,
            executionAttemptId,
            workerConfig.workflowId,
            infrastructure.conclude,
            terminalObservations.completion.complete,
          ),
        (error: unknown) => {
          controller.abort(error);
          // The result settles with the same refusal; nobody consumes it.
          void dispatch.result.catch(() => undefined);
          revokeBusIdentity?.();
          infrastructure.conclude(
            `Piscina worker for attempt '${executionAttemptId}' was refused before its workflow run was admitted: ` +
              (error instanceof Error ? error.message : String(error)),
          );
          terminalObservations.localObservationLoss.lose();
        },
      );

      return {
        kind: 'allocated',
        allocationRef,
        handle,
      };
    } catch (error) {
      // No handle reaches the caller on this path, so no later lifecycle owner
      // can stop a runner that did start, detach the caller forwarder, or give
      // up the attempt-scoped identity.
      controller.abort(error);
      detachCallerAbort();
      revokeBusIdentity?.();
      throw error;
    }
  }

  /**
   * Submit a workflow outcome through the Authority bus protocol after
   * the runner promise settles.
   *
   * On success, submits the runner's result directly. On failure, builds
   * a `failed` {@link WorkflowRunResult} from the error message. Attached
   * only once the thread's run was admitted: a rejection before admission is
   * infrastructure evidence, not a workflow outcome, and never reaches here.
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
   * @param onProviderCompletion - Reports positive completion after outcome acknowledgement or final local delivery exhaustion.
   */
  private async submitOutcomeOnSettlement(
    resultPromise: Promise<WorkflowRunResult>,
    executionId: string,
    executionAttemptId: string,
    workflowId: string,
    onInfrastructureConclusion: (summary: string) => void,
    onProviderCompletion: (observation: ProviderCompletionObservation) => void,
  ): Promise<void> {
    let result: WorkflowRunResult;
    try {
      result = await resultPromise;
    } catch (error) {
      // A rejection the provider itself caused, by aborting the task on
      // `cancel()`, lands here as a failed outcome too: the thread is killed
      // before its cooperative cancellation path can run. Classifying it as
      // cancelled must go by the rejection's cause, the provider's own abort
      // signal, never by a stop-request marker, which would also hide a real
      // failure that races a cancel. That classification belongs to the cancel
      // seam of the technical control protocol that follows this cut.
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
      // The runner settled and the bounded submit operation has stopped. That
      // leaves the canonical workflow outcome unresolved, but no Piscina
      // allocation duty or local delivery path remains. The separate
      // completion fact therefore closes provider infrastructure without
      // claiming the Authority accepted the outcome.
      onInfrastructureConclusion(
        `Piscina worker for attempt '${executionAttemptId}' ended without an acknowledged outcome ` +
          `because outcome submission could not be completed`,
      );
      onProviderCompletion(OUTCOME_DELIVERY_ENDED_COMPLETION);
      return;
    }

    // Keep cleanup and positive evidence outside the delivery-error branch:
    // an acknowledged outcome is not a failed submission merely because a
    // later local cleanup were to throw.
    onProviderCompletion(OUTCOME_ACKNOWLEDGED_COMPLETION);
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
