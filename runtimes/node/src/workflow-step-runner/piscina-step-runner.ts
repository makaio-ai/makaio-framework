import type { IStepRunner, StepRunConfig, StepRunResult } from '@makaio/contracts';
import type { PiscinaStepRunnerOptions, WorkerContributionManifest } from './types.js';
import { PiscinaPoolRunner } from './piscina-pool-runner.js';

interface PiscinaStepRunnerTask {
  /** Step configuration with definition, inputs, and bus info. */
  readonly config: StepRunConfig;
  /** Contribution manifest declaring which extension packages to load in workers. */
  readonly manifest: WorkerContributionManifest;
}

/**
 * Step runner that dispatches workflow steps to a Piscina worker-thread pool.
 *
 * Each step invocation is handed off to a pooled worker thread running the
 * `worker-entry.ts` entrypoint. The pool manages concurrency limits and idle
 * thread reaping automatically.
 */
export class PiscinaStepRunner implements IStepRunner {
  public readonly managesWorkflowLifecycle = false;

  private readonly pool: PiscinaPoolRunner<PiscinaStepRunnerTask, StepRunResult>;
  private readonly manifest: WorkerContributionManifest;

  /**
   * @param options - Piscina runner configuration including worker entry path
   *   and concurrency settings.
   */
  public constructor(options: PiscinaStepRunnerOptions) {
    this.manifest = options.manifest;
    this.pool = new PiscinaPoolRunner(options);
  }

  /**
   * Execute a workflow step in a pooled worker thread.
   * @param config - Step configuration with definition, inputs, and bus info.
   * @param signal - AbortSignal for cooperative cancellation.
   * @returns Step result with functional output and telemetry.
   */
  public async run(config: StepRunConfig, signal: AbortSignal): Promise<StepRunResult> {
    return this.pool.run({ config, manifest: this.manifest }, signal);
  }

  /**
   * Destroy the thread pool and release all worker threads.
   */
  public async dispose(): Promise<void> {
    await this.pool.dispose();
  }
}
