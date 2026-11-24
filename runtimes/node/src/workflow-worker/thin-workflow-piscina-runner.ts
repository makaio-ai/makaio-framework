import type { CallContext } from '@makaio/core';
import type { WorkflowWorkerConfig, WorkerContributionManifest } from '@makaio/contracts';
import type {
  IWorkflowRunner,
  ThinWorkflowPiscinaRunnerOptions,
  WorkflowRunnerCompletion,
  WorkflowRunResult,
} from './types.js';
import { PiscinaPoolRunner } from './runtime/piscina-pool-runner.js';
import { materializeWorkerTask, type MaterializedWorkerTask } from './worker-task-materialization.js';

/** Materialized workflow dispatched to the core worker entrypoint. */
interface ThinWorkflowPiscinaTask extends MaterializedWorkerTask {
  readonly kind: 'unbound' | 'caller-local-file';
  readonly manifest: WorkerContributionManifest;
}

/**
 * Thin workflow runner that dispatches workflow orchestration to a Piscina
 * worker-thread pool.
 *
 * Each workflow invocation is handed off to a pooled worker thread running the
 * `workflow-worker/worker-entry.ts` entrypoint. The worker isolates DAG control
 * flow and worker-local toolsets, while agent/subagent execution is delegated to
 * the host runtime. The pool manages concurrency limits and idle thread reaping
 * automatically.
 */
export class ThinWorkflowPiscinaRunner implements IWorkflowRunner {
  private readonly manifest: WorkerContributionManifest;
  private pool: PiscinaPoolRunner<ThinWorkflowPiscinaTask, WorkflowRunResult> | undefined;

  /** Unbound orchestration requires a serialized definition to keep source evaluation out of the worker thread. */
  public readonly requiresDefinitionSnapshot = true;

  /** Explicit file starts and replays share this runner's pool and worker connection. */
  public readonly callerLocalFileRunner: IWorkflowRunner = {
    run: (_call, config, signal, manifest) => this.runInPool('caller-local-file', config, signal, manifest),
  };

  /**
   * @param options - Piscina runner configuration including worker entry path
   *   and concurrency settings.
   */
  public constructor(private readonly options: ThinWorkflowPiscinaRunnerOptions) {
    this.manifest = options.manifest;
  }

  /**
   * Execute a complete workflow in a pooled worker thread.
   *
   * When `manifest` is provided it overrides the runner's construction-time
   * default, so per-request contribution sets from the Worker pool are
   * applied correctly without requiring a new runner instance.
   * @param _call - Accepted for interface conformance. The run executes in a pooled thread under that
   *   thread's `own('root')`; the requester's principal ends at the thread boundary (design limit).
   * @param config - Full workflow worker configuration with source, inputs, and bus info.
   * @param signal - AbortSignal for cooperative cancellation.
   * @param manifest - Optional per-call manifest override.
   * @returns Uncommitted completion; the host executor owns finalization.
   */
  public async run(
    _call: CallContext,
    config: WorkflowWorkerConfig,
    signal: AbortSignal,
    manifest?: WorkerContributionManifest,
  ): Promise<WorkflowRunnerCompletion> {
    return this.runInPool('unbound', config, signal, manifest);
  }

  /**
   * Materialize the source and invoke the same pool for either host-selected task type.
   * @param kind - Trusted dispatch choice made by the host's runner.
   * @param config - Portable workflow configuration.
   * @param signal - Signal for materialization and task execution.
   * @param manifest - Optional contribution override.
   * @returns Uncommitted workflow completion.
   */
  private async runInPool(
    kind: ThinWorkflowPiscinaTask['kind'],
    config: WorkflowWorkerConfig,
    signal: AbortSignal,
    manifest?: WorkerContributionManifest,
  ): Promise<WorkflowRunnerCompletion> {
    this.pool ??= new PiscinaPoolRunner(this.options);
    const resolvedManifest = manifest ?? this.manifest;
    const task = await materializeWorkerTask(this.options, config, resolvedManifest, signal);
    const result = await this.pool.run({ ...task, kind, manifest: resolvedManifest }, signal);
    return { state: 'uncommitted', result };
  }

  /**
   * Destroy the thread pool and release all worker threads.
   */
  public async dispose(): Promise<void> {
    await this.pool?.dispose();
  }
}
