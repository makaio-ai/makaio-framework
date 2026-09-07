import { randomUUID } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
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
import { createWorkflowWorkerReadyMessage } from './worker-ready-message.js';
import {
  bootWorkerBus,
  createWorkerBus,
  bootWorkerRuntime,
  type WorkerRuntimeBusHandle,
  type WorkerRuntimeHandle,
} from './runtime/worker-boot.js';
import { loadWorkerRuntimeContributions } from './runtime/worker-contributions.js';
import { registerAndAdmitWorkflowRun, type OperationDeliveryEndpoint } from './runtime-registration-client.js';
import { resolveAwaitTriggerConfig } from './await-trigger.js';
import { acceptPiscinaBootstrapHandoff, type PiscinaBootstrapBinding } from './piscina-bootstrap-handoff.js';
import {
  bootstrapWorkerRuntime,
  type BootstrapRuntimeConnection,
  type StartedWorkerRuntime,
} from './bootstrap-start-client.js';

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
 * Run parameters for a workflow no ExecutionAttempt owns.
 *
 * The host drove this run through {@link ThinWorkflowPiscinaRunner.run}: there
 * is no attempt to register a runtime with, no start gate to pass, and no
 * readiness fact to report to the pool.
 */
export interface UnboundWorkerParams extends WorkflowWorkerRunParamsBase {
  /**
   * Discriminator selecting the attempt-free lifecycle.
   *
   * Named for the binding, not for the work: `workflow-run` is the wire
   * operation kind the attempt-bound arm admits, and the two vocabularies must
   * not overlap.
   */
  readonly kind: 'unbound';
}

/**
 * Run parameters for a workflow an ExecutionAttempt owns.
 *
 * The attempt identifier is required: this arm proves the runtime to the
 * Authority and admits the run through the attempt's start gate before it
 * composes anything.
 */
export interface AttemptBoundWorkerParams extends WorkflowWorkerRunParamsBase {
  /** Discriminator selecting the attempt-bound lifecycle. */
  readonly kind: 'attempt-bound';
  /** Authority-created attempt this runtime registers itself as the endpoint of. */
  readonly executionAttemptId: string;
  /** Persisted absolute bootstrap deadline, unchanged across reconnects. */
  readonly bootstrapDeadlineAt: string;
}

/** Parameters accepted by the direct runtime entrypoint. */
export type WorkflowWorkerRunParams = UnboundWorkerParams | AttemptBoundWorkerParams;

/** Piscina-owned attempt tasks require a host budget handoff before runtime boot. */
type PiscinaWorkerRunParams = UnboundWorkerParams | (AttemptBoundWorkerParams & PiscinaBootstrapBinding);

// ─────────────────────────────────────────────────────────────
// Worker lifecycle
// ─────────────────────────────────────────────────────────────

/**
 * Execute a complete workflow inside an isolated worker context.
 *
 * Implements the full worker lifecycle:
 * 1. Parse and validate `config` against `WorkflowWorkerConfigSchema`
 * 2. Boot an isolated bus instance (with optional WebSocket transport)
 * 3. Subscribe cancellation routing and, on the attempt-bound arm, prove this
 *    runtime to the Authority: install the operation delivery endpoint,
 *    register the runtime, and admit the run through the attempt's start gate
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
 * @param params - Worker run parameters including config, verified contributions, and signal.
 * @returns The terminal workflow run result.
 * @throws {@link RuntimeRegistrationRefusedError} When the Authority refuses this runtime.
 * @throws {@link OperationAdmissionRefusedError} When the Authority refuses the run.
 */
export async function runWorkflowInWorker(params: WorkflowWorkerRunParams): Promise<WorkflowRunResult> {
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
  let deliveryEndpoint: OperationDeliveryEndpoint | undefined;

  try {
    // Step 2: Boot bus. The attempt-bound arm authenticates as the attempt
    // itself, because the Authority's registration and admission gates take
    // their caller identity from the authenticated transport peer.
    if (params.contributionEntrypoints.length !== params.manifest.contributionRefs.length) {
      throw new Error('Worker contribution materialization does not match the declared contribution identity set.');
    }

    // Step 3 (attempt-bound only): prove this runtime to the Authority before
    // it composes anything.
    if (params.kind === 'attempt-bound') {
      // One incarnation per invocation: it identifies this concrete thread to
      // the Authority and keys both the registration and the run's admission.
      const runtimeIncarnationId = randomUUID();
      const started = await bootstrapAttemptWorker(params, config, runtimeIncarnationId, abortController);
      handle = started.connection;
      deliveryEndpoint = started.endpoint;
      await registerAndAdmitWorkflowRun(handle.bus, {
        executionAttemptId: params.executionAttemptId,
        runtimeIncarnationId,
        endpoint: deliveryEndpoint,
        signal: abortController.signal,
      });
      // Posted here rather than after composition: the message now means "the
      // Authority accepted this runtime", and that is exactly what just
      // happened.
      parentPort?.postMessage(
        createWorkflowWorkerReadyMessage(config.executionId, config.cancelSubject, params.executionAttemptId),
      );
    } else {
      handle = await bootUnboundWorkerConnection(config, abortController);
    }

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
    return await runWorkflowOrchestrator({
      config: effectiveConfig,
      loaded,
      bus: handle.bus,
      signal: abortController.signal,
    });
  } finally {
    deliveryEndpoint?.cleanup();
    signal.removeEventListener('abort', abortFromParent);
    try {
      if (runtime) {
        await runtime.close();
      }
    } finally {
      if (handle) {
        await handle.close();
      }
    }
  }
}

/**
 * Acquire a fresh Attempt session and its start permission without loading code.
 * @param params - Attempt binding and original deadline.
 * @param config - Validated connection and cancellation routing data.
 * @param runtimeIncarnationId - Incarnation that will subsequently register.
 * @param controller - Work lifecycle cancellation.
 * @returns The permitted session and its endpoint.
 */
function bootstrapAttemptWorker(
  params: AttemptBoundWorkerParams,
  config: WorkflowWorkerConfig,
  runtimeIncarnationId: string,
  controller: AbortController,
): Promise<StartedWorkerRuntime> {
  return bootstrapWorkerRuntime({
    executionAttemptId: params.executionAttemptId,
    runtimeIncarnationId,
    bootstrapDeadlineAt: params.bootstrapDeadlineAt,
    signal: controller.signal,
    createConnection: () =>
      createCancellableWorkerConnection(
        createWorkerBus({ busUrl: config.busUrl, busAuth: config.busAuth, identityId: params.executionAttemptId }),
        config.cancelSubject,
        controller,
      ),
  });
}

/**
 * Connect an unbound worker without manufacturing an Attempt or bootstrap budget.
 * @param config - Validated bus configuration.
 * @param controller - Work lifecycle cancellation.
 * @returns Connected bus with cancellation-subscription cleanup ownership.
 */
async function bootUnboundWorkerConnection(
  config: WorkflowWorkerConfig,
  controller: AbortController,
): Promise<BootstrapRuntimeConnection> {
  const connected = await bootWorkerBus({ busUrl: config.busUrl, busAuth: config.busAuth }, controller.signal);
  const connection = createCancellableWorkerConnection(
    { ...connected, connect: async (signal) => signal.throwIfAborted() },
    config.cancelSubject,
    controller,
  );
  try {
    await connection.connect(controller.signal);
    return connection;
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

/**
 * Receive host bootstrap ownership before entering the ordinary worker lifecycle.
 * @param params - Piscina task, including a required handoff port for bound attempts.
 * @returns The terminal workflow result.
 */
export default async function runPiscinaWorkflow(params: PiscinaWorkerRunParams): Promise<WorkflowRunResult> {
  if (params.kind === 'attempt-bound') await acceptPiscinaBootstrapHandoff(params, params.signal);
  return runWorkflowInWorker(params);
}
