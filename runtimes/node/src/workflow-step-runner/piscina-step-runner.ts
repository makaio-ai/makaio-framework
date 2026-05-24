import Piscina from 'piscina';
import type { IStepRunner, StepRunConfig, StepRunResult } from '@makaio/contracts';
import type { PiscinaStepRunnerOptions, WorkerContributionManifest } from './types.js';

/**
 * Step runner that dispatches workflow steps to a Piscina worker-thread pool.
 *
 * Each step invocation is handed off to a pooled worker thread running the
 * `worker-entry.ts` entrypoint. The pool manages concurrency limits and idle
 * thread reaping automatically.
 */
export class PiscinaStepRunner implements IStepRunner {
  public readonly managesWorkflowLifecycle = false;

  private readonly pool: Piscina;
  private readonly manifest: WorkerContributionManifest;

  /**
   * @param options - Piscina runner configuration including worker entry path
   *   and concurrency settings.
   */
  public constructor(options: PiscinaStepRunnerOptions) {
    this.manifest = options.manifest;
    this.pool = new Piscina({
      filename: options.workerEntry,
      maxThreads: options.maxConcurrency ?? 4,
      idleTimeout: options.idleTimeoutMs ?? 30_000,
    });
  }

  /**
   * Execute a workflow step in a pooled worker thread.
   * @param config - Step configuration with definition, inputs, and bus info.
   * @param signal - AbortSignal for cooperative cancellation.
   * @returns Step result with functional output and telemetry.
   */
  public async run(config: StepRunConfig, signal: AbortSignal): Promise<StepRunResult> {
    return this.pool.run({ config, manifest: this.manifest }, { signal }) as Promise<StepRunResult>;
  }

  /**
   * Destroy the thread pool and release all worker threads.
   */
  public async dispose(): Promise<void> {
    await this.pool.destroy();
  }
}
