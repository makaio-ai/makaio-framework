import type {
  StationHandler,
  WorkerContributionManifest,
  WorkflowDefinition,
  WorkflowZodSchemas,
} from '@makaio/contracts';

export type { IWorkflowRunner, WorkflowRunResult } from '@makaio/contracts';

/**
 * Runtime-loaded workflow module shape consumed by the Node workflow runners.
 */
export interface RuntimeLoadedWorkflow {
  /** Serializable workflow definition. */
  readonly definition: WorkflowDefinition;
  /** Optional Zod schemas retained from workflow builder exports. */
  readonly zodSchemas?: WorkflowZodSchemas;
  /**
   * Runtime station handler functions keyed by node ID.
   * Used by the orchestrator to dispatch `station`-type nodes.
   */
  readonly runtimeHandlers: ReadonlyMap<string, StationHandler>;
}

/**
 * Configuration options for the thin Piscina-backed workflow runner.
 *
 * Controls the worker-thread pool that executes workflow orchestration in isolation
 * while delegating agent/subagent execution to the host runtime.
 */
export interface ThinWorkflowPiscinaRunnerOptions {
  /** Absolute path to the workflow worker entrypoint file. */
  readonly workerEntry: string;
  /** Contribution manifest declaring which extension packages to load in workers. */
  readonly manifest: WorkerContributionManifest;
  /** Maximum concurrent worker threads. @defaultValue 4 */
  readonly maxConcurrency?: number;
  /** Idle timeout before threads are reaped (ms). @defaultValue 30000 */
  readonly idleTimeoutMs?: number;
}
