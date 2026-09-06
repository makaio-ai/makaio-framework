import { randomUUID } from 'node:crypto';
import { createBusInstance, waitForSubscriptionPropagation, type IMakaioBus } from '@makaio/bus-core';
import { resolveMakaioHome } from '../makaio-config.js';
import {
  createWorkflowCancelSubject,
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  WorkflowSubjects,
  type OutcomeAckDecision,
  type WorkerBootstrapClaimResponse,
  type WorkerRuntimeContext,
  type WorkflowRunContext,
  type WorkflowRunResult,
} from '@makaio/contracts';
import type { KernelMakaioExtension } from '@makaio/kernel';
import type { Toolset } from '@makaio/tools-core';
import type { PrepareAdapterRuntimeInput } from '../compose-adapter-runtime.js';
import {
  createIsolatedWorkflowRuntime,
  type IsolatedWorkflowRuntime,
  type IsolatedWorkflowRuntimeContext,
} from './isolated-workflow-runtime.js';
import { submitOutcomeWithAck, type OutcomeSubmitRetryConfig } from './outcome-submission.js';
import {
  installOperationDeliveryEndpoint,
  registerAndAdmitWorkflowRun,
  type OperationDeliveryEndpoint,
} from './runtime-registration-client.js';

// ─────────────────────────────────────────────────────────────
// Dependency types
// ─────────────────────────────────────────────────────────────

/**
 * Bootstrap credentials returned by a provider-specific claim exchange.
 *
 * The harness receives these credentials after a successful bootstrap claim
 * and uses them to establish the authenticated bus connection.
 */
export type HeadlessWorkerBootstrapCredentials = WorkerBootstrapClaimResponse;

/**
 * Bootstrap the worker by claiming execution-scoped bus credentials.
 *
 * Implementations issue `WorkerSubjects.control['bootstrap.claim']`
 * against an unauthenticated or bootstrap-authenticated bus and return the
 * execution-scoped credentials for the authenticated connection.
 * @param signal - Cancellation signal. Abort rejects the bootstrap.
 * @returns Claimed credentials for the authenticated bus connection.
 */
export type HeadlessWorkerBootstrap = (signal: AbortSignal) => Promise<HeadlessWorkerBootstrapCredentials>;

/**
 * Establish the authenticated bus connection for the worker.
 *
 * Called after bootstrap with the claimed credentials. The implementation
 * registers a transport on the supplied bus and connects it.
 * @param bus - Worker-local bus instance to connect.
 * @param credentials - Credentials from the bootstrap claim.
 * @param signal - Cancellation signal.
 */
export type HeadlessWorkerBusConnector = (
  bus: IMakaioBus,
  credentials: HeadlessWorkerBootstrapCredentials,
  signal: AbortSignal,
) => Promise<void>;

/**
 * Result of materializing a portable run context into worker-local paths.
 *
 * The optional {@link cleanup} callback is invoked by the harness in its
 * finally teardown (best-effort, idempotent-safe) after runtime shutdown.
 * Implementations that acquire temporary resources (snapshot dirs, file
 * handles) should provide a cleanup callback to release them.
 */
export interface MaterializedWorkspace {
  /** Materialized worker-local runtime context with absolute paths. */
  readonly context: WorkerRuntimeContext;
  /**
   * Optional cleanup callback invoked during harness teardown.
   *
   * Must be idempotent — the harness may call it multiple times or
   * after partial initialization. Rejections are swallowed.
   */
  readonly cleanup?: () => Promise<void>;
}

/**
 * Materialize a portable run context into worker-local runtime context.
 *
 * The implementation resolves workspace snapshots or local directories,
 * verifies contribution integrity, and returns a {@link MaterializedWorkspace}
 * with absolute worker-local paths and an optional cleanup callback.
 * @param runContext - Persisted portable run context from the Authority.
 * @param signal - Cancellation signal.
 * @returns Materialized workspace with runtime context and optional cleanup.
 */
export type HeadlessWorkerMaterializer = (
  runContext: WorkflowRunContext,
  signal: AbortSignal,
) => Promise<MaterializedWorkspace>;

/**
 * Load kernel extension packages from resolved contribution entrypoints.
 *
 * Called with the materialized runtime context after workspace resolution.
 * @param runtimeContext - Materialized worker-local runtime context.
 * @param signal - Cancellation signal.
 * @returns Extension packages to activate in the isolated runtime.
 */
export type HeadlessWorkerContributionLoader = (
  runtimeContext: WorkerRuntimeContext,
  signal: AbortSignal,
) => Promise<readonly KernelMakaioExtension[]>;

/**
 * Execute the workflow after runtime composition and readiness.
 *
 * The implementation loads the workflow from the run context and drives it
 * through the orchestrator. The returned result is immutable.
 * @param bus - Connected worker-local bus.
 * @param runContext - Persisted portable run context.
 * @param runtimeContext - Materialized worker-local runtime context.
 * @param signal - Effective cancellation signal (combines caller + bus cancel).
 * @returns Immutable terminal workflow run result.
 */
export type HeadlessWorkerExecutor = (
  bus: IMakaioBus,
  runContext: WorkflowRunContext,
  runtimeContext: WorkerRuntimeContext,
  signal: AbortSignal,
) => Promise<WorkflowRunResult>;

/**
 * Optional post-commit observation callback.
 *
 * Invoked after the Authority durably acknowledges the outcome. Useful for
 * writing local artifact files or emitting provider-specific completion signals.
 * Failures are best-effort and must not replace the committed result.
 * @param result - Immutable workflow result.
 * @param decision - Durable ACK decision from the Authority.
 */
export type HeadlessWorkerPostCommitObserver = (
  result: WorkflowRunResult,
  decision: OutcomeAckDecision,
) => Promise<void>;

/**
 * Injected dependencies for the headless workflow worker harness.
 *
 * Product code and provider wrappers supply implementations of these seams.
 * The harness orchestrates their lifecycle without knowing about Git, GitHub,
 * snapshot stores, or any product-specific concepts.
 */
export interface HeadlessWorkflowWorkerDeps {
  /** Unique workflow execution identifier. */
  readonly executionId: string;
  /** Authority-created attempt identifier. */
  readonly executionAttemptId: string;
  /** Claim execution-scoped bus credentials. */
  readonly bootstrap: HeadlessWorkerBootstrap;
  /** Establish the authenticated bus connection. */
  readonly connectBus: HeadlessWorkerBusConnector;
  /** Materialize the portable spec into worker-local context. */
  readonly materialize: HeadlessWorkerMaterializer;
  /** Load contribution packages from materialized entrypoints. */
  readonly loadContributions: HeadlessWorkerContributionLoader;
  /** Execute the workflow on the composed runtime. */
  readonly execute: HeadlessWorkerExecutor;
  /** Adapter configuration repository for the isolated runtime. */
  readonly configRepository: PrepareAdapterRuntimeInput['configRepository'];
  /** Toolsets explicitly authorized for this runtime. */
  readonly toolsets: readonly Toolset[];
  /** Optional adapter auth preparation. */
  readonly prepareAuthRuntime?: PrepareAdapterRuntimeInput['prepareAuthRuntime'];
  /** Optional post-commit observation (e.g. artifact persistence). */
  readonly onPostCommit?: HeadlessWorkerPostCommitObserver;
  /**
   * Optional retry configuration for outcome submission.
   *
   * Controls exponential back-off parameters, overall deadline, and
   * maximum retry count. When omitted, sane defaults apply (7 retries,
   * 1 s base delay, 30 s cap, 2 min deadline).
   */
  readonly outcomeRetry?: OutcomeSubmitRetryConfig;
}

/**
 * Terminal result of a headless worker execution.
 *
 * Contains the immutable workflow result and the Authority's durable ACK
 * decision so callers can distinguish first-time acceptance from replay.
 */
export interface HeadlessWorkflowWorkerResult {
  /** Immutable terminal workflow run result. */
  readonly result: WorkflowRunResult;
  /** Durable ACK decision from the Authority. */
  readonly decision: OutcomeAckDecision;
}

/** A propagated workflow-cancellation subscription and its cleanup callback. */
interface WorkflowCancellationSubscription {
  /** Signal that aborts when the workflow cancellation event arrives. */
  readonly signal: AbortSignal;
  /** Removes the bus subscription. */
  readonly cleanup: () => void;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Build a cancelled {@link WorkflowRunResult} for cooperative cancellation.
 * @param executionId - Workflow execution identifier.
 * @param workflowId - Workflow definition identifier.
 * @returns Immutable cancelled result.
 */
function buildCancelledResult(executionId: string, workflowId: string): WorkflowRunResult {
  return {
    executionId,
    workflowId,
    status: 'cancelled',
    reason: 'Execution cancelled',
  };
}

/**
 * Subscribe to a workflow cancellation subject and wait for the subscription
 * to be visible to the Authority before continuing the lifecycle.
 * @param bus - Connected bus on which to listen for cancellation.
 * @param cancelSubject - Execution-specific cancellation subject.
 * @param priorSignal - Earlier lifecycle cancellation signal to carry forward.
 * @returns Propagated cancellation subscription.
 */
async function subscribeToWorkflowCancellation(
  bus: IMakaioBus,
  cancelSubject: string,
  priorSignal?: AbortSignal,
): Promise<WorkflowCancellationSubscription> {
  const controller = new AbortController();
  const cleanup = bus.on(createWorkflowCancelSubject(cancelSubject), () => {
    controller.abort();
  });
  const abortFromPriorSignal = () => {
    controller.abort();
  };
  priorSignal?.addEventListener('abort', abortFromPriorSignal, { once: true });
  if (priorSignal?.aborted) {
    controller.abort();
  }
  await waitForSubscriptionPropagation(cleanup);
  return {
    signal: controller.signal,
    cleanup: () => {
      priorSignal?.removeEventListener('abort', abortFromPriorSignal);
      cleanup();
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Harness implementation
// ─────────────────────────────────────────────────────────────

/**
 * Build the {@link IsolatedWorkflowRuntimeContext} from the materialized
 * worker runtime context, supplying the host-level fields the isolated
 * runtime requires for adapter and extension activation.
 * @param runtimeCtx - Materialized worker-local runtime context.
 * @param machineId - Stable machine identity for this worker.
 * @returns Host context for the isolated runtime compositor.
 */
function buildIsolatedContext(runtimeCtx: WorkerRuntimeContext, machineId: string): IsolatedWorkflowRuntimeContext {
  // homedir and makaioHome are worker-machine-local paths, not the
  // materialized workspace root. The workspace is where the workflow source
  // and contributions live; makaioHome is where this machine's Makaio data
  // (npm packages, config, DB) lives — resolved from MAKAIO_HOME or ~/.makaio.
  const makaioHome = resolveMakaioHome();
  return {
    cwd: runtimeCtx.workspaceRoot,
    platform: runtimeCtx.platform,
    homedir: makaioHome,
    makaioHome,
    username: 'workflow-worker',
    machineId,
  };
}

/**
 * Compose the runtime after its workspace and contributions are available.
 * @param deps - Injected worker dependencies.
 * @param credentials - Claimed authenticated bus credentials.
 * @param runtimeContext - Materialized worker-local runtime context.
 * @param contributedPackages - Contributions to activate in the runtime.
 * @param signal - Effective pre-composition cancellation signal.
 * @param machineId - Stable worker machine identity.
 * @returns Connected isolated runtime.
 */
async function composeWorkflowRuntime(
  deps: HeadlessWorkflowWorkerDeps,
  credentials: HeadlessWorkerBootstrapCredentials,
  runtimeContext: WorkerRuntimeContext,
  contributedPackages: readonly KernelMakaioExtension[],
  signal: AbortSignal,
  machineId: string,
): Promise<IsolatedWorkflowRuntime> {
  return await createIsolatedWorkflowRuntime({
    connectAuthority: async (bus) => {
      await deps.connectBus(bus, credentials, signal);
    },
    contributedPackages: [...contributedPackages],
    configRepository: deps.configRepository,
    context: buildIsolatedContext(runtimeContext, machineId),
    toolsets: [...deps.toolsets],
    ...(deps.prepareAuthRuntime !== undefined && { prepareAuthRuntime: deps.prepareAuthRuntime }),
  });
}

/**
 * Submit a cooperative-cancellation outcome through the currently connected bus.
 * @param deps - Injected worker dependencies.
 * @param bus - Connected pre-composition or runtime bus.
 * @param workflowId - Workflow definition identifier.
 * @returns Terminal cancelled result and durable ACK decision.
 */
async function deliverCancelledOutcome(
  deps: HeadlessWorkflowWorkerDeps,
  bus: IMakaioBus,
  workflowId: string,
): Promise<HeadlessWorkflowWorkerResult> {
  const { executionId, executionAttemptId } = deps;
  const result = buildCancelledResult(executionId, workflowId);
  const decision = await submitOutcomeWithAck(
    bus,
    { executionAttemptId, executionId, result },
    { retry: deps.outcomeRetry, reconnect: () => bus.reconnect() },
  );
  return { result, decision };
}

/**
 * Execute the workflow and deliver its outcome for durable ACK.
 *
 * Captures execution errors as a `failed` result and invokes the optional
 * post-commit observer after the Authority acknowledges the outcome.
 * @param deps - Injected harness dependencies.
 * @param runtime - Composed isolated runtime.
 * @param runContext - Persisted portable run context.
 * @param runtimeContext - Materialized worker-local runtime context.
 * @param signal - Effective cancellation signal.
 * @returns Terminal result and durable ACK decision.
 */
async function executeAndDeliver(
  deps: HeadlessWorkflowWorkerDeps,
  runtime: IsolatedWorkflowRuntime,
  runContext: WorkflowRunContext,
  runtimeContext: WorkerRuntimeContext,
  signal: AbortSignal,
): Promise<HeadlessWorkflowWorkerResult> {
  const { executionId, executionAttemptId } = deps;

  let result: WorkflowRunResult;
  try {
    result = await deps.execute(runtime.bus, runContext, runtimeContext, signal);
  } catch (executionError) {
    // Cooperative cancellation: when the effective signal is aborted and the
    // error is an AbortError, produce a 'cancelled' result rather than a
    // generic 'failed' result. This aligns with the WorkflowRunResult
    // discriminated union and lets the Authority distinguish intentional
    // cancellation from unexpected failures.
    if (signal.aborted && executionError instanceof DOMException && executionError.name === 'AbortError') {
      result = buildCancelledResult(executionId, runContext.workflowId);
    } else {
      result = {
        executionId,
        workflowId: runContext.workflowId,
        status: 'failed',
        error: executionError instanceof Error ? executionError.message : String(executionError),
      };
    }
  }

  const decision = await submitOutcomeWithAck(
    runtime.bus,
    {
      executionAttemptId,
      executionId,
      result,
    },
    {
      retry: deps.outcomeRetry,
      reconnect: () => runtime.bus.reconnect(),
    },
  );

  if (deps.onPostCommit !== undefined) {
    try {
      await deps.onPostCommit(result, decision);
    } catch {
      // Post-commit observation is best-effort.
    }
  }

  return { result, decision };
}

/**
 * Materialize, compose, and execute a workflow after the Authority supplies its
 * portable run context.
 * @param deps - Injected worker dependencies.
 * @param credentials - Claimed authenticated bus credentials.
 * @param preBus - Connected bus used before runtime composition.
 * @param runContext - Persisted portable run context.
 * @param signal - Cancellation signal from the process/caller.
 * @param machineId - Stable worker machine identity.
 * @param incarnation - This runtime's identity and accepted generation, for the runtime-bus endpoint.
 * @param releasePreDeliveryEndpoint - Removes the pre-composition delivery endpoint; idempotent.
 * @returns Terminal result and durable ACK decision.
 */
async function runWorkflowLifecycle(
  deps: HeadlessWorkflowWorkerDeps,
  credentials: HeadlessWorkerBootstrapCredentials,
  preBus: IMakaioBus,
  runContext: WorkflowRunContext,
  signal: AbortSignal,
  machineId: string,
  incarnation: { readonly runtimeIncarnationId: string; readonly runtimeGeneration: number },
  releasePreDeliveryEndpoint: () => void,
): Promise<HeadlessWorkflowWorkerResult> {
  const preCancellation = await subscribeToWorkflowCancellation(preBus, runContext.cancelSubject);
  const earlyEffectiveSignal = AbortSignal.any([signal, preCancellation.signal]);
  let lifecycleSignal = earlyEffectiveSignal;
  let runtime: IsolatedWorkflowRuntime | undefined;
  let runtimeCancellation: WorkflowCancellationSubscription | undefined;
  let runtimeDeliveryEndpoint: OperationDeliveryEndpoint | undefined;
  let materializedCleanup: (() => Promise<void>) | undefined;

  try {
    earlyEffectiveSignal.throwIfAborted();
    const materialized = await deps.materialize(runContext, earlyEffectiveSignal);
    const runtimeContext = materialized.context;
    materializedCleanup = materialized.cleanup;

    earlyEffectiveSignal.throwIfAborted();
    const contributedPackages = await deps.loadContributions(runtimeContext, earlyEffectiveSignal);
    earlyEffectiveSignal.throwIfAborted();
    runtime = await composeWorkflowRuntime(
      deps,
      credentials,
      runtimeContext,
      contributedPackages,
      earlyEffectiveSignal,
      machineId,
    );

    runtimeCancellation = await subscribeToWorkflowCancellation(
      runtime.bus,
      runContext.cancelSubject,
      preCancellation.signal,
    );
    // The delivery endpoint moves with the cancel subscription: it is reachable
    // on the runtime bus before the pre-composition socket goes away, so the
    // attempt never stops answering `execution-attempt.operation.deliver`.
    runtimeDeliveryEndpoint = await installOperationDeliveryEndpoint(
      runtime.bus,
      { executionAttemptId: deps.executionAttemptId, ...incarnation },
      {},
    );
    preCancellation.cleanup();
    releasePreDeliveryEndpoint();
    preBus.disconnect();

    const effectiveSignal = AbortSignal.any([signal, runtimeCancellation.signal]);
    lifecycleSignal = effectiveSignal;
    effectiveSignal.throwIfAborted();
    return await executeAndDeliver(deps, runtime, runContext, runtimeContext, effectiveSignal);
  } catch (phaseError) {
    const isCooperativeCancellation =
      lifecycleSignal.aborted && phaseError instanceof DOMException && phaseError.name === 'AbortError';
    if (!isCooperativeCancellation) {
      throw phaseError;
    }
    return await deliverCancelledOutcome(deps, runtime?.bus ?? preBus, runContext.workflowId);
  } finally {
    preCancellation.cleanup();
    runtimeCancellation?.cleanup();
    runtimeDeliveryEndpoint?.cleanup();
    if (runtime !== undefined) {
      await runtime.shutdown().catch(() => undefined);
    }
    if (materializedCleanup !== undefined) {
      await materializedCleanup().catch(() => undefined);
    }
  }
}

/**
 * Run a single workflow execution through the portable headless worker harness.
 *
 * The runtime proves itself to the Authority before it asks for work: the
 * delivery endpoint is installed first, `execution-attempt.runtime.register`
 * returns only after the Authority made readiness durable, and the whole legacy
 * run then passes the attempt's start gate as one admitted `workflow-run`
 * operation. Kernel readiness is emitted later, by
 * `createIsolatedWorkflowRuntime` during composition.
 * @param deps - Injected provider and product dependencies.
 * @param signal - Cancellation signal from the process/caller.
 * @returns Terminal result and durable ACK decision.
 * @throws {@link OutcomeDeliveryError} When the Authority rejects the outcome.
 * @throws {@link RuntimeRegistrationRefusedError} When the Authority refuses this runtime.
 * @throws {@link OperationAdmissionRefusedError} When the Authority refuses the run.
 * @throws When bootstrap, connection, materialization, or runtime composition fails.
 */
export async function runHeadlessWorkflowWorker(
  deps: HeadlessWorkflowWorkerDeps,
  signal: AbortSignal,
): Promise<HeadlessWorkflowWorkerResult> {
  signal.throwIfAborted();
  // One incarnation per invocation: it identifies this concrete runtime process
  // to the Authority and keys both the registration and the run's admission.
  const runtimeIncarnationId = randomUUID();
  const credentials = await deps.bootstrap(signal);
  signal.throwIfAborted();

  const preBus = createBusInstance();
  preBus.registerNamespaces([...FrameworkContractNamespaces, ...FrameworkStorageNamespaces]);
  let preDeliveryEndpoint: OperationDeliveryEndpoint | undefined;
  const releasePreDeliveryEndpoint = (): void => {
    const endpoint = preDeliveryEndpoint;
    preDeliveryEndpoint = undefined;
    endpoint?.cleanup();
  };
  try {
    await deps.connectBus(preBus, credentials, signal);
    // Before registration, not after: the Authority delivers its bounded probe
    // inside the register request, and an unsubscribed runtime fails its own
    // registration with `probe-failed`.
    preDeliveryEndpoint = await installOperationDeliveryEndpoint(
      preBus,
      { executionAttemptId: deps.executionAttemptId, runtimeIncarnationId },
      {},
    );
    const { runtimeGeneration } = await registerAndAdmitWorkflowRun(preBus, {
      executionAttemptId: deps.executionAttemptId,
      runtimeIncarnationId,
      endpoint: preDeliveryEndpoint,
      signal,
    });
    const runContext = await preBus.request(
      WorkflowSubjects.getRunContext,
      { executionId: deps.executionId },
      { signal },
    );
    return await runWorkflowLifecycle(
      deps,
      credentials,
      preBus,
      runContext,
      signal,
      `headless-worker-${deps.executionAttemptId}`,
      { runtimeIncarnationId, runtimeGeneration },
      releasePreDeliveryEndpoint,
    );
  } finally {
    releasePreDeliveryEndpoint();
    try {
      preBus.disconnect();
    } catch {
      // The runtime handoff may already have disconnected this temporary bus.
    }
  }
}
