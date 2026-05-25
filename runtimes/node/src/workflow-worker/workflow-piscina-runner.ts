import type { WorkflowWorkerConfig } from '@makaio/contracts';
import type { IWorkflowRunner, WorkflowPiscinaRunnerOptions, WorkflowRunResult } from './types.js';
import type { WorkerContributionManifest } from '../workflow-step-runner/types.js';
import { PiscinaPoolRunner } from '../workflow-step-runner/piscina-pool-runner.js';

interface WorkflowPiscinaRunnerTask {
  /** Workflow worker configuration with source, inputs, and bus info. */
  readonly config: WorkflowWorkerConfig;
  /** Contribution manifest declaring which extension packages to load in workers. */
  readonly manifest: WorkerContributionManifest;
}

/**
 * Workflow runner that dispatches full workflow executions to a Piscina
 * worker-thread pool.
 *
 * Each workflow invocation is handed off to a pooled worker thread running the
 * `workflow-worker/worker-entry.ts` entrypoint. The pool manages concurrency
 * limits and idle thread reaping automatically.
 */
export class WorkflowPiscinaRunner implements IWorkflowRunner {
  private readonly pool: PiscinaPoolRunner<WorkflowPiscinaRunnerTask, WorkflowRunResult>;
  private readonly manifest: WorkerContributionManifest;

  /**
   * @param options - Piscina runner configuration including worker entry path
   *   and concurrency settings.
   */
  public constructor(options: WorkflowPiscinaRunnerOptions) {
    this.manifest = options.manifest;
    this.pool = new PiscinaPoolRunner(options);
  }

  /**
   * Execute a complete workflow in a pooled worker thread.
   * @param config - Full workflow worker configuration with source, inputs, and bus info.
   * @param signal - AbortSignal for cooperative cancellation.
   * @returns Execution result with terminal status and optional output.
   */
  public async run(config: WorkflowWorkerConfig, signal: AbortSignal): Promise<WorkflowRunResult> {
    return this.pool.run({ config, manifest: this.manifest }, signal);
  }

  /**
   * Destroy the thread pool and release all worker threads.
   */
  public async dispose(): Promise<void> {
    await this.pool.dispose();
  }
}
