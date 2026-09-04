import type { IMakaioBus } from '@makaio/bus-core';
import type {
  IWorkflowRunner,
  WorkerContributionManifest,
  WorkflowRunnerCompletion,
  WorkflowWorkerConfig,
} from '@makaio/contracts';
import { WorkflowWorkerConfigSchema } from '@makaio/contracts';
import { runWorkflowOrchestrator } from '@makaio/subsystem-workflow-engine/workflow-orchestrator';
import { loadWorkflowFromConfig } from './workflow-loader.js';
import { resolveAwaitTriggerConfig } from './await-trigger.js';

// ─────────────────────────────────────────────────────────────
// Constructor options
// ─────────────────────────────────────────────────────────────

/**
 * Constructor options for {@link InProcessWorkflowRunner}.
 */
export interface InProcessWorkflowRunnerOptions {
  /**
   * Bus instance shared with the host runtime.
   *
   * The runner does not boot its own bus or runtime services — it reuses the
   * caller-owned bus so workflow orchestration participates in the same event
   * fabric as all other framework services.
   */
  readonly bus: IMakaioBus;
}

// ─────────────────────────────────────────────────────────────
// InProcessWorkflowRunner
// ─────────────────────────────────────────────────────────────

/**
 * In-process implementation of {@link IWorkflowRunner}.
 *
 * Executes a full workflow inside the calling process using the shared host
 * bus. Unlike the Piscina and Worker runners, this runner does not spawn
 * isolated processes or threads — the workflow orchestrator runs inline on the
 * caller's bus.
 *
 * Use this runner when the host process already owns a fully-booted bus and
 * the workflow's step types do not require process isolation (e.g. pure shell,
 * agent, and gate steps sourced from a serialized definition).
 *
 * The bus lifecycle is owned by the caller. This runner holds no disposable
 * resources of its own, so `dispose()` is intentionally omitted.
 */
export class InProcessWorkflowRunner implements IWorkflowRunner {
  readonly #bus: IMakaioBus;

  /**
   * @param options - Options including the caller-owned bus instance.
   */
  public constructor(options: InProcessWorkflowRunnerOptions) {
    this.#bus = options.bus;
  }

  /**
   * Execute a complete workflow in-process using the shared host bus.
   *
   * Steps:
   * 1. Load the workflow from the config source descriptor.
   * 2. Pass the loaded workflow, config, bus, and signal to the orchestrator.
   *
   * The `manifest` parameter is accepted for interface conformance but is
   * unused — in-process execution does not load worker-local contributions.
   * @param config - Workflow worker configuration to validate before execution.
   * @param signal - AbortSignal for cooperative cancellation.
   * @param _manifest - Ignored; in-process runners share the host contribution set.
   * @returns Uncommitted completion; the host executor owns finalization.
   */
  public async run(
    config: WorkflowWorkerConfig,
    signal: AbortSignal,
    _manifest?: WorkerContributionManifest,
  ): Promise<WorkflowRunnerCompletion> {
    const parsedConfig = WorkflowWorkerConfigSchema.parse(config);
    const loaded = await loadWorkflowFromConfig(parsedConfig);
    const effectiveConfig = await resolveAwaitTriggerConfig(parsedConfig, loaded, this.#bus, signal);
    const result = await runWorkflowOrchestrator({
      config: effectiveConfig,
      loaded,
      bus: this.#bus,
      signal,
    });
    return { state: 'uncommitted', result };
  }
}
