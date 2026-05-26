import type { EventMessagePayload, SubjectDefinition } from '@makaio/core';
import {
  WorkflowWorkerConfigSchema,
  createWorkflowCancelSubject,
  type BusEventTrigger,
  type WorkerContributionManifest,
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
// Await-trigger mode
// ─────────────────────────────────────────────────────────────

type AdHocEventPayload = EventMessagePayload;
type AdHocEventSubject = SubjectDefinition<Record<string, AdHocEventPayload>, string, string>;

/**
 * Build an ad-hoc event subject definition from a fully qualified subject string.
 *
 * Same pattern as {@link createWorkflowCancelSubject} — constructs a subject
 * definition without a registered Zod schema for bus routing.
 * @param fullSubject - Fully qualified subject in `namespace.subject` form, e.g. `git.checkout`.
 * @returns Ad-hoc subject definition suitable for {@link IMakaioBus.on}.
 */
function createAdHocEventSubject(fullSubject: string): AdHocEventSubject {
  const separator = fullSubject.indexOf('.');
  if (separator <= 0 || separator === fullSubject.length - 1) {
    throw new Error(`Invalid trigger subject: ${fullSubject}`);
  }

  return {
    subject: fullSubject.slice(separator + 1),
    $meta: {
      namespace: fullSubject.slice(0, separator),
      isRequest: false,
      payload: {} as AdHocEventPayload,
      local: false,
      channel: false,
    },
  };
}

/**
 * Subscribe to declared bus-event triggers and wait for the first matching event.
 *
 * Returns the event payload of the first trigger that fires. All subscriptions
 * are cleaned up before returning. Rejects if the abort signal fires first.
 * @param bus - Worker bus handle for subscriptions.
 * @param triggers - Bus-event trigger definitions from the loaded workflow.
 * @param signal - Abort signal for cooperative cancellation.
 * @returns Matched event payload to use as `triggerPayload` for the orchestrator.
 */
function awaitBusEventTrigger(
  bus: WorkerBusHandle['bus'],
  triggers: readonly BusEventTrigger[],
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Await-trigger aborted'));
      return;
    }

    const cleanups: Array<() => void> = [];

    /**
     *
     */
    function cleanup(): void {
      for (const fn of cleanups) fn();
      cleanups.length = 0;
    }

    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new Error('Await-trigger aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', onAbort));

    for (const trigger of triggers) {
      const subject = createAdHocEventSubject(trigger.subject);
      const unsubscribe = bus.on(
        subject,
        (ctx) => {
          cleanup();
          resolve(ctx.payload as Record<string, unknown>);
        },
        trigger.filter ? { filter: trigger.filter } : undefined,
      );
      cleanups.push(unsubscribe);
    }
  });
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

    // Step 5b: Await-trigger mode — when no trigger payload was provided and
    // the workflow declares bus-event triggers, subscribe and wait for the
    // first matching event before running the DAG.
    let effectiveConfig = config;
    const busEventTriggers = (loaded.definition.triggers ?? []).filter(
      (t): t is BusEventTrigger => t.type === 'bus-event',
    );
    const hasEmptyTriggerPayload = Object.keys(config.triggerPayload).length === 0;

    if (hasEmptyTriggerPayload && busEventTriggers.length > 0) {
      const matchedPayload = await awaitBusEventTrigger(handle.bus, busEventTriggers, abortController.signal);
      effectiveConfig = { ...config, triggerPayload: matchedPayload };
    }

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
