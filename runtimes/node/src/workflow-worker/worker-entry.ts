import {
  WorkflowWorkerConfigSchema,
  createWorkflowCancelSubject,
  type WorkflowStep,
  type WorkflowRunResult,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import { loadWorkflowModule } from './workflow-file-loader.js';
import { runWorkflowOrchestrator, type LoadedWorkflow } from '@makaio/subsystem-workflow-engine/workflow-orchestrator';
import {
  bootWorkerBus,
  bootWorkerRuntime,
  type WorkerBusHandle,
  type WorkerRuntimeHandle,
} from '../workflow-step-runner/worker-boot.js';
import { loadWorkerContributions } from '../workflow-step-runner/worker-contributions.js';
import type { WorkerContributionManifest } from '../workflow-step-runner/types.js';

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
// Internal helpers
// ─────────────────────────────────────────────────────────────

/**
 * Resolve a {@link LoadedWorkflow} from the parsed worker config.
 *
 * Routing rules:
 * - `source.kind === 'definition'` with a populated `config.definition`:
 *   builds the {@link LoadedWorkflow} in-place from the serialized definition.
 *   DB workflows use shell, agent, and gate steps exclusively; there are no
 *   function steps, so `runtimeSteps` is an empty Map.
 * - All other source kinds delegate to the file-loader which handles `'path'`
 *   and `'source'` variants.
 * @param config - Parsed and validated worker configuration.
 * @returns The loaded workflow ready for the orchestrator.
 * @throws When `source.kind === 'definition'` but `config.definition` is absent.
 */
async function loadWorkflowFromConfig(config: WorkflowWorkerConfig): Promise<LoadedWorkflow> {
  if (config.source.kind === 'definition') {
    if (config.definition === undefined) {
      throw new Error(
        `Definition-sourced worker config for workflowId "${config.source.workflowId}" ` +
          `is missing the required 'definition' field. ` +
          `Ensure the executor populates WorkflowWorkerConfig.definition before dispatching.`,
      );
    }
    const functionStep = findFunctionStep(config.definition.steps);
    if (functionStep) {
      throw new Error(
        `Definition-sourced workflow "${config.definition.id}" contains function step "${functionStep.id}". ` +
          'Function steps require file/source-authored runtime functions.',
      );
    }
    return {
      definition: config.definition,
      runtimeSteps: new Map(),
    };
  }

  return loadWorkflowModule(config.source);
}

/**
 * Find a runtime-only function step inside a definition-sourced workflow.
 * @param steps - Workflow steps to scan recursively.
 * @returns First function step found, or undefined when the definition is serializable.
 */
function findFunctionStep(steps: readonly WorkflowStep[]): WorkflowStep | undefined {
  for (const step of steps) {
    if (step.type === 'function') return step;
    if (step.type === 'for-each') {
      const nested = findFunctionStep(step.steps);
      if (nested) return nested;
    }
  }
  return undefined;
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

    // Step 3: Load contributions
    const contributions = await loadWorkerContributions(params.manifest, {
      bus: handle.bus,
      signal: abortController.signal,
    });

    // Step 4: Boot runtime only when contributions are present
    const hasContributions = contributions.toolsets.length > 0 || contributions.adapters.length > 0;
    if (hasContributions) {
      runtime = await bootWorkerRuntime(handle, contributions, {
        cwd: config.context.repoPath,
        env: config.env,
      });
    }

    // Step 5: Load workflow module from source
    const loaded = await loadWorkflowFromConfig(config);

    // Step 6: Run orchestrator
    return await runWorkflowOrchestrator({
      config,
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
