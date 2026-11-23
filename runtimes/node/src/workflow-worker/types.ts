import type {
  CodeStepHandler,
  LoopCheckHandler,
  WorkerContributionManifest,
  WorkerRuntimeContext,
  WorkflowDefinition,
  WorkflowZodSchemas,
} from '@makaio/contracts';
import type { WorkspaceRootResolver } from './local-directory-materializer.js';

export type { IWorkflowRunner, WorkflowRunnerCompletion, WorkflowRunResult } from '@makaio/contracts';

/**
 * Runtime-loaded workflow module shape consumed by the Node workflow runners.
 */
export interface RuntimeLoadedWorkflow {
  /** Serializable workflow definition. */
  readonly definition: WorkflowDefinition;
  /** Optional Zod schemas retained from workflow builder exports. */
  readonly zodSchemas?: WorkflowZodSchemas;
  /**
   * Runtime code step handler functions keyed by node ID.
   * Used by the orchestrator to dispatch `code-step`-type nodes.
   */
  readonly runtimeHandlers: ReadonlyMap<string, CodeStepHandler>;
  /**
   * Loop check handler functions keyed by handler name.
   * Used by the orchestrator to evaluate loop convergence.
   */
  readonly runtimeLoopChecks?: ReadonlyMap<string, LoopCheckHandler>;
}

/**
 * Worker-local workspace and optional cleanup for materialized executables.
 */
export interface MaterializedWorkspace {
  /** Runtime context with absolute local paths. */
  readonly context: WorkerRuntimeContext;
  /** Idempotent cleanup of the materialized executable root. */
  readonly cleanup?: () => Promise<void>;
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
  /**
   * Host-owned resolver for portable local-directory workspace IDs.
   *
   * Required when a Piscina task has a path-backed source or declared worker
   * contributions. The runner realizes those portable references before it
   * transfers the task to a worker thread.
   */
  readonly resolveWorkspaceRoot?: WorkspaceRootResolver;
  /** Maximum concurrent worker threads. @defaultValue 4 */
  readonly maxConcurrency?: number;
  /** Idle timeout before threads are reaped (ms). @defaultValue 30000 */
  readonly idleTimeoutMs?: number;
}
