import { randomUUID } from 'node:crypto';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  WorkflowRunResultSchema,
  type ExecutionAttemptOutcome,
  type OutcomeAckDecision,
  type WorkerBootstrapCredentials,
  type WorkerRuntimeContext,
  type WorkflowRunContext,
  type WorkflowRunResult,
} from '@makaio/contracts';
import type { KernelMakaioExtension } from '@makaio/kernel';
import type { Toolset } from '@makaio/tools-core';
import type { PrepareAdapterRuntimeInput } from '../compose-adapter-runtime.js';
import type { OutcomeSubmitRetryConfig } from './outcome-submission.js';
import { runWorkloadInvocation } from './workload-invocation.js';
import { createWorkflowWorkloadAdapter } from './workflow-workload-adapter.js';
import { registerWorkerRuntime } from './runtime-registration-client.js';
import { bootstrapWorkerRuntime, type BootstrapRuntimeConnection } from './bootstrap-start-client.js';
import { withWorkerBootstrapDeadline } from './worker-bootstrap-exchange.js';

// ─────────────────────────────────────────────────────────────
// Dependency types
// ─────────────────────────────────────────────────────────────

/**
 * Bootstrap credentials returned by a provider-specific claim exchange.
 *
 * The harness receives these credentials after a successful bootstrap claim
 * and uses them to establish the authenticated bus connection.
 */
export type HeadlessWorkerBootstrapCredentials = WorkerBootstrapCredentials;

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
 * Workflow executable and contribution paths acquired inside Invocation.
 *
 * This legacy name does not declare a project Workspace. Cleanup is permitted
 * only after an acknowledged workload result without preservation obligations. A root
 * shared with the prepared project Workspace has that Workspace's cleanup owner.
 */
export interface MaterializedWorkspace {
  /** Materialized worker-local runtime context with absolute paths. */
  readonly context: WorkerRuntimeContext;
  /**
   * Optional idempotent executable-root cleanup, after acknowledged execution.
   * Never called for technical failure, cancellation, unacknowledged outcomes or roots overlapping a project Workspace.
   */
  readonly cleanup?: () => Promise<void>;
}

/**
 * Materialize a portable run context into worker-local runtime context.
 *
 * The implementation resolves workspace snapshots or local directories,
 * verifies contribution integrity, and returns a {@link MaterializedWorkspace}
 * with absolute worker-local paths and an optional cleanup callback.
 * @param runContext - Local DTO reconstructed from frozen input and selected Runtime inputs.
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
 * @param runContext - Local DTO reconstructed from frozen input and selected Runtime inputs.
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
  /** Immutable absolute deadline created with the Attempt, shared by every bootstrap phase. */
  readonly bootstrapDeadlineAt: string;
  /** Explicit host-delivered workflow environment; never inferred from ambient process state. */
  readonly workflowEnv: Readonly<Record<string, string>>;
  /** Private setup-process environment, supplied separately from workflowEnv and never persisted. */
  readonly setupEnv?: Readonly<NodeJS.ProcessEnv>;
  /** Claim execution-scoped bus credentials. */
  readonly bootstrap: HeadlessWorkerBootstrap;
  /** Establish the authenticated bus connection. */
  readonly connectBus: HeadlessWorkerBusConnector;
  /** Explicit project Workspace path; required only by an instruction requesting one. */
  readonly workspaceRoot?: string;
  /** Materialize executable and contribution paths inside admitted Invocation. */
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
 * Preserves technical failure, cancellation and actual workflow results, together with
 * the Authority's durable acknowledgement.
 */
export interface HeadlessWorkflowWorkerResult {
  /** Canonical technical failure, cancellation or the workflow's actual returned result. */
  readonly outcome: ExecutionAttemptOutcome;
  /** Durable ACK decision from the Authority. */
  readonly decision: OutcomeAckDecision;
}

/**
 * Observe only a genuine workflow result after canonical acknowledgement.
 * @param deps - Worker dependencies with an optional observer.
 * @param result - Canonically acknowledged Invocation outcome.
 */
async function observeCommittedWorkflow(
  deps: HeadlessWorkflowWorkerDeps,
  result: HeadlessWorkflowWorkerResult,
): Promise<void> {
  if (result.outcome.kind !== 'workload-result' || deps.onPostCommit === undefined) return;
  try {
    const workflowResult = WorkflowRunResultSchema.parse(result.outcome.result);
    await deps.onPostCommit(workflowResult, result.decision);
  } catch {
    // Observation is best-effort, including callbacks that throw before returning a promise.
  }
}

/**
 * Register one Runtime, then run optional Workspace Preparation and Invocation.
 *
 * The authenticated control bus stays connected through the canonical outcome
 * acknowledgement. Workflow code acquisition and runtime composition happen
 * only inside the installed workflow adapter's admitted Invocation.
 * @param deps - Provider and installed workflow adapter dependencies.
 * @param signal - Cancellation signal from the process or caller.
 * @returns Canonical outcome and durable acknowledgement.
 */
export async function runHeadlessWorkflowWorker(
  deps: HeadlessWorkflowWorkerDeps,
  signal: AbortSignal,
): Promise<HeadlessWorkflowWorkerResult> {
  signal.throwIfAborted();
  const workflowEnv = { ...deps.workflowEnv };
  const runtimeIncarnationId = randomUUID();
  const credentials = await withWorkerBootstrapDeadline(deps.bootstrapDeadlineAt, signal, (bootstrapSignal) =>
    deps.bootstrap(bootstrapSignal),
  );
  const { connection, endpoint } = await bootstrapWorkerRuntime({
    executionAttemptId: deps.executionAttemptId,
    runtimeIncarnationId,
    bootstrapDeadlineAt: deps.bootstrapDeadlineAt,
    signal,
    createConnection: () => createHeadlessConnection(deps, credentials),
  });
  const preBus = connection.bus;
  const workflow = createWorkflowWorkloadAdapter({ ...deps, workflowEnv }, credentials, preBus);
  let result: HeadlessWorkflowWorkerResult | undefined;
  try {
    const runtimeGeneration = await registerWorkerRuntime(preBus, {
      executionAttemptId: deps.executionAttemptId,
      runtimeIncarnationId,
      signal,
    });
    endpoint.bindGeneration(runtimeGeneration);
    result = await runWorkloadInvocation(preBus, {
      executionAttemptId: deps.executionAttemptId,
      runtimeGeneration,
      workspaceRoot: deps.workspaceRoot,
      setupEnv: deps.setupEnv,
      adapters: [workflow.adapter],
      signal,
      retry: deps.outcomeRetry,
      reconnect: () => preBus.reconnect(),
    });
    await observeCommittedWorkflow(deps, result);
    return result;
  } finally {
    try {
      await workflow.releaseExecutable(result);
    } finally {
      endpoint.cleanup();
      await connection.close();
    }
  }
}

/**
 * Acquire cleanup ownership before a provider starts asynchronous connection work.
 * @param deps - Provider connector and workload dependencies.
 * @param credentials - Attempt-scoped credentials, without private environment data.
 * @returns A fresh connection whose late failure cannot retain a transport.
 */
function createHeadlessConnection(
  deps: HeadlessWorkflowWorkerDeps,
  credentials: HeadlessWorkerBootstrapCredentials,
): BootstrapRuntimeConnection {
  const bus = createBusInstance();
  bus.registerNamespaces([...FrameworkContractNamespaces, ...FrameworkStorageNamespaces]);
  return {
    bus,
    async connect(signal) {
      try {
        await deps.connectBus(bus, credentials, signal);
        signal.throwIfAborted();
      } catch (error) {
        bus.disconnect();
        throw error;
      }
    },
    close: () => bus.disconnect(),
  };
}
