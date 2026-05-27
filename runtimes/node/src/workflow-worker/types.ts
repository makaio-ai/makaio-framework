import type {
  JsonValue,
  PreviousStepOutput,
  WorkerContributionManifest,
  WorkflowDefinitionInput,
  WorkflowStepFunction,
} from '@makaio/contracts';

export type { IWorkflowRunner, WorkflowRunResult } from '@makaio/contracts';

/**
 * Runtime-loaded workflow module shape consumed by the Node workflow runners.
 */
export interface RuntimeLoadedWorkflow {
  /** Serializable workflow definition. */
  readonly definition: WorkflowDefinitionInput;
  /** Runtime function steps keyed by workflow step ID. */
  readonly runtimeSteps: ReadonlyMap<
    string,
    WorkflowStepFunction<unknown, Record<string, PreviousStepOutput<JsonValue>>, JsonValue>
  >;
}

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
