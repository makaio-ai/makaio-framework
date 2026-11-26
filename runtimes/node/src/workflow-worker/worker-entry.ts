import type { RegistrableBusNamespaceDefinition } from '@makaio/core';
import { waitForSubscriptionPropagation } from '@makaio/bus-core';
import {
  WorkflowError,
  WorkflowErrorCode,
  WorkflowWorkerLaunchConfigSchema,
  createWorkflowCancelSubject,
  type OrderedWorkerBootstrapAuth,
  type WorkerContributionManifest,
  type WorkflowRunResult,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import {
  createWorkerBus,
  bootWorkerRuntime,
  type BootstrapRuntimeConnection,
  type WorkerRuntimeBusHandle,
  type WorkerRuntimeHandle,
} from './runtime/worker-boot.js';
import { loadWorkerRuntimeContributions } from './runtime/worker-contributions.js';
import {
  runProcessWorkflow,
  runRegisteredProcessWorkflow,
  type ProcessWorkflowRunOptions,
} from './process-workflow.js';
import { runLoadedWorkflowLocally } from './in-process-workflow-runner.js';
import { loadWorkflowFromConfig } from './workflow-loader.js';
import { bindFileStepRequests } from './file-step-requests.js';
import { deepFreeze } from '@makaio/utils';

// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// This file implements the Piscina worker-thread entrypoint — a deliberately
// separate lifecycle from the headless worker harness (headless-workflow-worker.ts).
//
// The headless harness is designed for remote workers that bootstrap over the
// network, pull run context from the bus, materialize workspaces from portable
// specs, and submit outcomes via bus ACK.  Piscina workers run in-process on
// the same machine as the coordinator, receive fully-resolved config via
// Piscina's `run()` method, and return results through the worker thread's
// return value.
//
// Materializers establish contribution identity and return verified worker-local
// entrypoints before this worker starts.

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

/**
 * Fields every worker-entry invocation carries, whatever gate it runs behind.
 *
 * Mirrors the shape passed by {@link ThinWorkflowPiscinaRunner} — the `config`
 * is the raw (unserialized) `WorkflowWorkerConfig`, `manifest` declares the
 * exact contribution identity, and `contributionEntrypoints` is the matching
 * verified local realization returned by materialization.
 */
export interface WorkflowWorkerRunParamsBase {
  /** Raw workflow worker launch configuration, validated in the worker. */
  readonly config: unknown;
  /** Verified workspace root supplied by the host's materializer. */
  readonly workspaceRoot?: string;
  /** Contribution manifest declaring which extension packages to load. */
  readonly manifest: WorkerContributionManifest;
  /** Verified worker-local entrypoints in manifest order. */
  readonly contributionEntrypoints: readonly string[];
  /** Optional abort signal for cooperative cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * Run parameters for a workflow started without a host-owned worker binding.
 *
 * The host drove this run through {@link ThinWorkflowPiscinaRunner.run}: there
 * is no attempt to register a runtime with, no start gate to pass, and no
 * readiness fact to report to the pool.
 */
export interface UnboundWorkerParams extends WorkflowWorkerRunParamsBase {
  /**
   * Discriminator selecting the attempt-free lifecycle.
   *
   */
  readonly kind: 'unbound';
}

/** Host-selected local file execution on the existing Piscina task channel. */
interface CallerLocalFileWorkerParams extends WorkflowWorkerRunParamsBase {
  readonly kind: 'caller-local-file';
}

/** Inputs for opening a worker's bus before it loads its workflow. */
export interface WorkerConnectorContext {
  /** Validated worker configuration. */
  readonly config: WorkflowWorkerConfig;
  /** Aborted when the run is cancelled. */
  readonly controller: AbortController;
  /**
   * Acquire a connection that routes the run's cancel subject to the controller.
   * @param identityId - Optional transport identity for the connection.
   * @param namespaces - Protocol namespaces hosted by the isolated worker.
   * @returns Disposable connection that the connector must open before returning.
   */
  createConnection(
    identityId?: string,
    namespaces?: readonly RegistrableBusNamespaceDefinition[],
  ): BootstrapRuntimeConnection;
}

/** Open connection from a worker connector. */
export interface ConnectedWorker {
  /** Bus handle whose lifetime is owned by the worker entry. */
  readonly connection: WorkerRuntimeBusHandle;
  /** Optional callback released after execution, before the connection closes. */
  readonly release?: () => void;
  /** Model authority injected locally by the trusted worker composer. */
  readonly stepModel?: ProcessWorkflowRunOptions['model'];
}

/** Open the worker bus and perform any host admission before workflow composition. */
export type WorkerConnector = (context: WorkerConnectorContext) => Promise<ConnectedWorker>;

// ─────────────────────────────────────────────────────────────
// Worker lifecycle
// ─────────────────────────────────────────────────────────────

/**
 * Execute a complete workflow inside an isolated worker context.
 *
 * Implements the full worker lifecycle:
 * 1. Parse and validate `config` against `WorkflowWorkerLaunchConfigSchema`
 * 2. Boot an isolated bus instance (with optional WebSocket transport)
 * 3. Subscribe cancellation routing and run any admission supplied by the host
 * 4. Load worker-local contributions from verified materialization output
 * 5. Boot worker-local tool runtime if toolset contributions exist
 * 6. Run the process workflow orchestrator with the frozen definition
 * 7. Always close the runtime (when booted) and bus in the `finally` block
 *
 * Registration precedes contribution loading, which is the whole point:
 * readiness must not depend on what the runtime later composes.
 *
 * Contributions are loaded once per workflow, not once per step — the
 * orchestrator owns step dispatch and reuses the same bus and runtime
 * throughout the execution.
 *
 * Design limit: the run executes under the worker bus's `own('root')`. The
 * requester's principal ends at the thread boundary; it reaches the run again only
 * once the job run is a caller with its own credential.
 * @param params - Worker run parameters including config, verified contributions, and signal.
 * @param connector - Host-owned worker connection and admission.
 * @returns The terminal workflow run result.
 */
export function runWorkflowInWorker(
  params: UnboundWorkerParams,
  connector: WorkerConnector = connectUnboundWorker,
): Promise<WorkflowRunResult> {
  return runWorkerTask(params, connector, 'admitted');
}

/**
 * Share bus boot, contribution loading and cleanup for both Piscina task types.
 * @param params - Configuration and materialized contribution entrypoints.
 * @param connector - Trusted worker bus connector.
 * @param taskKind - Execution path selected by the trusted worker entry.
 * @returns Workflow result for the host executor.
 */
async function runWorkerTask(
  params: WorkflowWorkerRunParamsBase,
  connector: WorkerConnector,
  taskKind: 'admitted' | 'unbound' | 'caller-local-file',
): Promise<WorkflowRunResult> {
  let { orderedBusAuth, ...config } = WorkflowWorkerLaunchConfigSchema.parse(params.config);
  const requiresOrderDecoder = orderedBusAuth !== undefined;
  const contributionEntrypoints = Object.freeze([...params.contributionEntrypoints]);
  const { workspaceRoot } = params;
  const callerLocalFile = taskKind === 'caller-local-file';
  if (callerLocalFile && (config.source.kind !== 'path' || config.terminalAuthority === 'authority')) {
    throw new WorkflowError(WorkflowErrorCode.NOT_EXECUTABLE, 'Caller-local execution requires a host-owned file task');
  }

  const abortController = new AbortController();
  const removeParentAbort = followParentAbort(params.signal, abortController);

  let handle: WorkerRuntimeBusHandle | undefined;
  let runtime: WorkerRuntimeHandle | undefined;
  let release: (() => void) | undefined;

  try {
    if (contributionEntrypoints.length !== params.manifest.contributionRefs.length) {
      throw new Error('Worker contribution materialization does not match the declared contribution identity set.');
    }

    const connectorContext = createWorkerConnectorContext(config, abortController, orderedBusAuth);
    orderedBusAuth = undefined;
    const connected = await connector(connectorContext);
    handle = connected.connection;
    release = connected.release;
    if (requiresOrderDecoder) {
      throw new WorkflowError(WorkflowErrorCode.NOT_EXECUTABLE, 'Ordered worker requires a bound order decoder');
    }

    // Step 4: Import only the entrypoints verified by materialization. Import
    // failures are fatal — workers never proceed with a partial set.
    const contributions = await loadWorkerRuntimeContributions(contributionEntrypoints, {
      bus: handle.bus,
      signal: abortController.signal,
    });

    // Step 5: Boot the worker-local tool runtime only when toolsets are present.
    const hasToolsets = contributions.toolsets.length > 0;
    if (hasToolsets) {
      runtime = await bootWorkerRuntime(handle, contributions);
    }

    // ORIGIN: The thread starts the run itself; the requester's call does not cross the thread boundary.
    const call = handle.bus.own('root');
    if (callerLocalFile) {
      const loaded = await loadWorkflowFromConfig(config);
      const fileHostRoute =
        connector === connectUnboundWorker &&
        !!config.busUrl &&
        config.source.kind === 'path' &&
        config.terminalAuthority !== 'authority';
      return await runLoadedWorkflowLocally({
        call,
        config,
        loaded: fileHostRoute ? bindFileStepRequests(loaded, handle.bus, call) : loaded,
        bus: handle.bus,
        signal: abortController.signal,
        workspaceRoot,
      });
    }
    // Piscina tasks receive the frozen definition and source from their host executor.
    const processRun = {
      call,
      config,
      bus: handle.bus,
      signal: abortController.signal,
      workspace: workspaceRoot ?? process.cwd(),
      ...(connected.stepModel === undefined ? {} : { model: connected.stepModel }),
    };
    return await runPiscinaProcessTask(processRun, workspaceRoot, taskKind, connector);
  } finally {
    removeParentAbort();
    try {
      release?.();
    } finally {
      try {
        await runtime?.close();
      } finally {
        await handle?.close();
      }
    }
  }
}

/**
 * Follow parent cancellation for as long as the worker task owns its controller.
 * @param signal - Parent cancellation lifetime, when supplied.
 * @param controller - Worker-local cancellation, also controlled by the bus.
 * @returns Listener cleanup for the worker's finally block.
 */
function followParentAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  const abort = (): void => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return () => signal?.removeEventListener('abort', abort);
}

/**
 * Select whether this Piscina route can bind a registered executable source.
 * @param options - Worker-owned process launch options.
 * @param workspaceRoot - Host-materialized root for path-backed tasks.
 * @param taskKind - Lifecycle selected at the worker entry.
 * @param connector - Worker-local connection and admission implementation.
 * @returns Workflow result after process teardown.
 */
function runPiscinaProcessTask(
  options: ProcessWorkflowRunOptions,
  workspaceRoot: string | undefined,
  taskKind: 'admitted' | 'unbound',
  connector: WorkerConnector,
): Promise<WorkflowRunResult> {
  const admitted = taskKind === 'admitted';
  const authorityOwned = options.config.terminalAuthority === 'authority';
  // The default connection only opens a bus. An authority-owned task needs the host's admission connector.
  const canBindSource = admitted ? authorityOwned && connector !== connectUnboundWorker : !authorityOwned;
  return canBindSource ? runRegisteredProcessWorkflow(options, workspaceRoot, admitted) : runProcessWorkflow(options);
}

/**
 * Prepare the per-run connection factory and cancellation routing.
 * @param config - Validated worker execution configuration.
 * @param controller - Controller shared with the orchestrator.
 * @param orderedBusAuth - Private bootstrap material to consume at connection creation.
 * @returns Connector inputs bound to this worker.
 */
function createWorkerConnectorContext(
  config: WorkflowWorkerConfig,
  controller: AbortController,
  orderedBusAuth?: OrderedWorkerBootstrapAuth,
): WorkerConnectorContext {
  const { busUrl, cancelSubject } = config;
  let exchange = orderedBusAuth === undefined ? undefined : deepFreeze(structuredClone(orderedBusAuth));
  const legacy = exchange === undefined ? Object.freeze({ ...config.busAuth }) : undefined;
  return {
    config,
    controller,
    createConnection: (identityId, namespaces) => {
      const busAuth = exchange ?? legacy;
      if (busAuth === undefined) throw new Error('Worker exchange connection was already acquired');
      exchange = undefined;
      return createCancellableWorkerConnection(
        createWorkerBus({ busUrl, busAuth, identityId, namespaces }),
        cancelSubject,
        controller,
      );
    },
  };
}

/**
 * Open the default worker connection without extra host admission.
 * @param context - Connection factory and lifecycle controller.
 * @returns Open worker connection.
 */
async function connectUnboundWorker({
  createConnection,
  controller,
}: WorkerConnectorContext): Promise<ConnectedWorker> {
  const connection = createConnection();
  try {
    await connection.connect(controller.signal);
    return { connection };
  } catch (error) {
    await connection.close();
    throw error;
  }
}

/**
 * Keep cancellation subscription ownership with each disposable bus session.
 * @param connection - Synchronously acquired bus connection handle.
 * @param cancelSubject - Workflow-specific cancellation routing key.
 * @param controller - Work lifecycle cancellation, independent of the bootstrap lease.
 * @returns Connection wrapper retaining cancellation routing until close.
 */
function createCancellableWorkerConnection(
  connection: BootstrapRuntimeConnection,
  cancelSubject: string,
  controller: AbortController,
): BootstrapRuntimeConnection {
  let unsubscribe: (() => void) | undefined;
  return {
    bus: connection.bus,
    get bootstrapPayload() {
      return connection.bootstrapPayload;
    },
    async connect(signal) {
      await connection.connect(signal);
      signal.throwIfAborted();
      unsubscribe = connection.bus.on(createWorkflowCancelSubject(cancelSubject), () => controller.abort());
      await waitForSubscriptionPropagation(unsubscribe);
      signal.throwIfAborted();
    },
    async close() {
      unsubscribe?.();
      unsubscribe = undefined;
      await connection.close();
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Piscina entrypoint
// ─────────────────────────────────────────────────────────────

/**
 * Bind the connector inside a host-selected Piscina worker entry module.
 * The host sets the absolute entry module path via `workflowRunner.workerEntry`.
 * Only the workflow task crosses the thread boundary. The connector and its
 * optional model authority are constructed in the worker module.
 * @param connector - Worker-local bus and model composition.
 * @returns Piscina's task handler, including caller-local file routing.
 */
export function createPiscinaWorker(
  connector: WorkerConnector,
): (params: UnboundWorkerParams | CallerLocalFileWorkerParams) => Promise<WorkflowRunResult> {
  return (params) => runWorkerTask(params, connector, params.kind);
}

export default createPiscinaWorker(connectUnboundWorker);
