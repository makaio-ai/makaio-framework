import { randomUUID } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import { waitForSubscriptionPropagation } from '@makaio/bus-core';
import {
  WorkflowWorkerConfigSchema,
  createWorkflowCancelSubject,
  type WorkerContributionManifest,
  type WorkflowRunResult,
} from '@makaio/contracts';
import { runWorkflowOrchestrator } from '@makaio/subsystem-workflow-engine/workflow-orchestrator';
import { loadWorkflowFromConfig } from './workflow-loader.js';
import { createWorkflowWorkerReadyMessage } from './worker-ready-message.js';
import {
  bootWorkerBus,
  bootWorkerRuntime,
  type WorkerRuntimeBusHandle,
  type WorkerRuntimeHandle,
} from './runtime/worker-boot.js';
import { loadWorkerRuntimeContributions } from './runtime/worker-contributions.js';
import {
  installOperationDeliveryEndpoint,
  registerAndAdmitWorkflowRun,
  type OperationDeliveryEndpoint,
} from './runtime-registration-client.js';
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
}

/** Parameters accepted by the Piscina worker entrypoint. */
export type WorkflowWorkerRunParams = UnboundWorkerParams | AttemptBoundWorkerParams;

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
  let cancelCleanup: (() => void) | undefined;
  let deliveryEndpoint: OperationDeliveryEndpoint | undefined;

  try {
    // Step 2: Boot bus. The attempt-bound arm authenticates as the attempt
    // itself, because the Authority's registration and admission gates take
    // their caller identity from the authenticated transport peer.
    handle = await bootWorkerBus({
      busUrl: config.busUrl,
      busAuth: config.busAuth,
      ...(params.kind === 'attempt-bound' ? { identityId: params.executionAttemptId } : {}),
    });

    // Step 3: Subscribe to the workflow-level cancel subject so the main
    // process can abort this worker cooperatively via the bus when it handles
    // WorkflowSubjects.cancel for this execution.
    cancelCleanup = handle.bus.on(createWorkflowCancelSubject(config.cancelSubject), () => {
      abortController.abort();
    });
    await waitForSubscriptionPropagation(cancelCleanup);

    if (params.contributionEntrypoints.length !== params.manifest.contributionRefs.length) {
      throw new Error('Worker contribution materialization does not match the declared contribution identity set.');
    }

    // Step 3 (attempt-bound only): prove this runtime to the Authority before
    // it composes anything.
    if (params.kind === 'attempt-bound') {
      // One incarnation per invocation: it identifies this concrete thread to
      // the Authority and keys both the registration and the run's admission.
      const runtimeIncarnationId = randomUUID();
      // Before registration, not after: the Authority delivers its bounded
      // probe inside the register request, and an unsubscribed runtime fails
      // its own registration with `probe-failed`.
      deliveryEndpoint = await installOperationDeliveryEndpoint(
        handle.bus,
        { executionAttemptId: params.executionAttemptId, runtimeIncarnationId },
        {},
      );
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
    cancelCleanup?.();
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

// ─────────────────────────────────────────────────────────────
// Piscina entrypoint
// ─────────────────────────────────────────────────────────────

// Piscina targets the default export of the worker entrypoint.
export default runWorkflowInWorker;
