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
  type WorkerBusHandle,
  type WorkerRuntimeHandle,
} from '../workflow-step-runner/worker-boot.js';
import { loadWorkerContributions } from '../workflow-step-runner/worker-contributions.js';
import { resolveAwaitTriggerConfig } from './await-trigger.js';

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

/**
 * Parameters accepted by the Piscina worker entrypoint.
 *
 * Mirrors the shape passed by {@link WorkflowPiscinaRunner.run} — the `config`
 * is the raw (unserialized) `WorkflowWorkerConfig` and the `manifest` declares
 * which extension packages to load.
 */
export interface WorkflowWorkerRunParams {
  /** Raw workflow worker configuration (will be validated by Zod schema). */
  readonly config: unknown;
  /** Contribution manifest declaring which extension packages to load. */
  readonly manifest: WorkerContributionManifest;
  /** Optional abort signal for cooperative cancellation. */
  readonly signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────
// Worker lifecycle
// ─────────────────────────────────────────────────────────────

/**
 * Execute a complete workflow inside an isolated worker context.
 *
 * Implements the full worker lifecycle:
 * 1. Parse and validate `config` against `WorkflowWorkerConfigSchema`
 * 2. Boot an isolated bus instance (with optional WebSocket transport)
 * 3. Load worker-local contributions from the manifest
 * 4. Boot worker-local tool and adapter runtime if contributions exist
 * 5. Load the workflow module from the source descriptor
 * 6. Run the workflow orchestrator
 * 7. Always close the runtime (when booted) and bus in the `finally` block
 *
 * Contributions are loaded once per workflow, not once per step — the
 * orchestrator owns step dispatch and reuses the same bus and runtime
 * throughout the execution.
 * @param params - Worker run parameters including config, manifest, and signal.
 * @returns The terminal workflow run result.
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

  let handle: WorkerBusHandle | undefined;
  let runtime: WorkerRuntimeHandle | undefined;
  let cancelCleanup: (() => void) | undefined;

  try {
    // Step 2: Boot bus
    handle = await bootWorkerBus(config);

    // Step 3a: Subscribe to the workflow-level cancel subject so the main
    // process can abort this worker cooperatively via the bus when it handles
    // WorkflowSubjects.cancel for this execution.
    cancelCleanup = handle.bus.on(createWorkflowCancelSubject(config.cancelSubject), () => {
      abortController.abort();
    });
    await waitForSubscriptionPropagation(cancelCleanup);

    // Step 3: Load contributions — pass makaioHome so that relative import
    // paths in the manifest (npm-installed packages) are resolved to absolute
    // paths on this machine before import().
    const contributions = await loadWorkerContributions(params.manifest, {
      bus: handle.bus,
      signal: abortController.signal,
      makaioHome: config.context.makaioHome,
    });

    // Step 4: Boot runtime only when contributions are present
    const hasContributions = contributions.toolsets.length > 0 || contributions.adapters.length > 0;
    if (hasContributions) {
      runtime = await bootWorkerRuntime(handle, contributions, {
        cwd: config.context.repoPath,
        env: config.env,
      });
    }

    parentPort?.postMessage(
      createWorkflowWorkerReadyMessage(config.executionId, config.cancelSubject, runtime?.adapterIds ?? []),
    );

    // Step 5: Load workflow module from source
    const loaded = await loadWorkflowFromConfig(config);

    const effectiveConfig = await resolveAwaitTriggerConfig(config, loaded, handle.bus, abortController.signal);

    // Step 6: Run orchestrator
    return await runWorkflowOrchestrator({
      config: effectiveConfig,
      loaded,
      bus: handle.bus,
      signal: abortController.signal,
    });
  } finally {
    cancelCleanup?.();
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
