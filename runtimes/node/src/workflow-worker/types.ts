import type { WorkerContributionManifest } from '../workflow-step-runner/types.js';

export type { IWorkflowRunner, WorkflowRunResult } from '@makaio/contracts';

/**
 * Configuration options for the Piscina-backed workflow runner.
 *
 * Controls the worker-thread pool that executes full workflow runs in isolation.
 */
export interface WorkflowPiscinaRunnerOptions {
  /** Absolute path to the workflow worker entrypoint file. */
  readonly workerEntry: string;
  /** Contribution manifest declaring which extension packages to load in workers. */
  readonly manifest: WorkerContributionManifest;
  /** Maximum concurrent worker threads. @defaultValue 4 */
  readonly maxConcurrency?: number;
  /** Idle timeout before threads are reaped (ms). @defaultValue 30000 */
  readonly idleTimeoutMs?: number;
}
