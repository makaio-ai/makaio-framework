import type { RegistrableBusNamespaceDefinition } from '@makaio/core';
import { waitForSubscriptionPropagation } from '@makaio/bus-core';
import {
  WorkflowWorkerConfigSchema,
  createWorkflowCancelSubject,
  type WorkerContributionManifest,
  type WorkflowRunResult,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import { runWorkflowOrchestrator } from '@makaio/subsystem-workflow-engine/workflow-orchestrator';
import { loadWorkflowFromConfig } from './workflow-loader.js';
import {
  createWorkerBus,
  bootWorkerRuntime,
  type BootstrapRuntimeConnection,
  type WorkerRuntimeBusHandle,
  type WorkerRuntimeHandle,
} from './runtime/worker-boot.js';
import { loadWorkerRuntimeContributions } from './runtime/worker-contributions.js';
import { resolveAwaitTriggerConfig } from './await-trigger.js';

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
  /** Raw workflow worker configuration (will be validated by Zod schema). */
  readonly config: unknown;
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
 * 1. Parse and validate `config` against `WorkflowWorkerConfigSchema`
 * 2. Boot an isolated bus instance (with optional WebSocket transport)
 * 3. Subscribe cancellation routing and run any admission supplied by the host
 * 4. Load worker-local contributions from verified materialization output
 * 5. Boot worker-local tool runtime if toolset contributions exist
 * 6. Load the workflow module from the source descriptor
 * 7. Run the workflow orchestrator
 * 8. Always close the runtime (when booted) and bus in the `finally` block
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
export async function runWorkflowInWorker(
  params: UnboundWorkerParams,
  connector: WorkerConnector = connectUnboundWorker,
): Promise<WorkflowRunResult> {
  // Step 1: Validate config eagerly so invalid configs never reach bus/runtime setup.
  const config = WorkflowWorkerConfigSchema.parse(params.config);

  const abortController = new AbortController();
  const abortFromParent = (): void => abortController.abort();
  const signal = params.signal ?? abortController.signal;

  if (signal !== abortController.signal) {
    if (signal.aborted) {
      abortController.abort();
    } else {
      signal.addEventListener('abort', abortFromParent, { once: true });
    }
  }

  let handle: WorkerRuntimeBusHandle | undefined;
  let runtime: WorkerRuntimeHandle | undefined;
  let release: (() => void) | undefined;

  try {
    if (params.contributionEntrypoints.length !== params.manifest.contributionRefs.length) {
      throw new Error('Worker contribution materialization does not match the declared contribution identity set.');
    }

    const connected = await connector(createWorkerConnectorContext(config, abortController));
    handle = connected.connection;
    release = connected.release;

    // Step 4: Import only the entrypoints verified by materialization. Import
    // failures are fatal — workers never proceed with a partial set.
    const contributions = await loadWorkerRuntimeContributions(params.contributionEntrypoints, {
      bus: handle.bus,
      signal: abortController.signal,
    });

    // Step 5: Boot the worker-local tool runtime only when toolsets are present.
    const hasToolsets = contributions.toolsets.length > 0;
    if (hasToolsets) {
      runtime = await bootWorkerRuntime(handle, contributions);
    }

    // Step 6: Load workflow module from source
    const loaded = await loadWorkflowFromConfig(config);

    const effectiveConfig = await resolveAwaitTriggerConfig(config, loaded, handle.bus, abortController.signal);

    // Step 7: Run orchestrator
    // ORIGIN: The thread starts the run itself; the requester's call does not cross the thread boundary.
    return await runWorkflowOrchestrator({
      call: handle.bus.own('root'),
      config: effectiveConfig,
      loaded,
      bus: handle.bus,
      signal: abortController.signal,
    });
  } finally {
    signal.removeEventListener('abort', abortFromParent);
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
 * Prepare the per-run connection factory and cancellation routing.
 * @param config - Validated worker execution configuration.
 * @param controller - Controller shared with the orchestrator.
 * @returns Connector inputs bound to this worker.
 */
function createWorkerConnectorContext(
  config: WorkflowWorkerConfig,
  controller: AbortController,
): WorkerConnectorContext {
  return {
    config,
    controller,
    createConnection: (identityId, namespaces) =>
      createCancellableWorkerConnection(
        createWorkerBus({ busUrl: config.busUrl, busAuth: config.busAuth, identityId, namespaces }),
        config.cancelSubject,
        controller,
      ),
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

export default runWorkflowInWorker;
