import type { StepRunnerBusAuth } from '@makaio/contracts';

// ---------------------------------------------------------------------------
// Shared base fields for all runner modes
// ---------------------------------------------------------------------------

/** Base configuration fields shared by all step runner modes. */
interface NodeStepRunnerBaseOptions {
  /** Bus server WebSocket URL for runner worker connections. */
  readonly busUrl?: string;
  /** Bus authentication strategy for runner worker connections. */
  readonly busAuth?: StepRunnerBusAuth;
  /** Working directory for step process spawning. */
  readonly cwd: string;
}

/** Base options for isolated execution modes that require a contribution manifest. */
interface IsolatedStepRunnerBaseOptions extends NodeStepRunnerBaseOptions {
  /** Contribution manifest declaring which extension packages to load in workers. */
  readonly manifest: WorkerContributionManifest;
}

// ---------------------------------------------------------------------------
// Per-mode option types
// ---------------------------------------------------------------------------

/** Options for in-process (no isolation) step execution. */
export interface InProcessStepRunnerOptions extends NodeStepRunnerBaseOptions {
  readonly mode: 'in-process';
}

/** Options for Piscina worker-thread pool step execution. */
export interface PiscinaStepRunnerOptions extends IsolatedStepRunnerBaseOptions {
  readonly mode: 'piscina';
  /** Absolute path to the worker entrypoint file. */
  readonly workerEntry: string;
  /** Maximum concurrent worker threads. @defaultValue 4 */
  readonly maxConcurrency?: number;
  /** Idle timeout before threads are reaped (ms). @defaultValue 30000 */
  readonly idleTimeoutMs?: number;
}

/** Options for child-process step execution via spawned Node processes. */
export interface ChildProcessStepRunnerOptions extends IsolatedStepRunnerBaseOptions {
  readonly mode: 'child-process';
  /** Absolute path to the worker entrypoint file. */
  readonly workerEntry: string;
}

/** Options for Docker container step execution. */
export interface DockerStepRunnerOptions extends IsolatedStepRunnerBaseOptions {
  readonly mode: 'docker';
  /** Docker image name (must be pre-pulled). */
  readonly imageName: string;
  /** Absolute path to the worker entrypoint file inside the container. */
  readonly workerEntry: string;
  /** Network mode for the container. @defaultValue 'host' */
  readonly networkMode?: string;
}

/**
 * Configuration options for the Node.js step runner factory.
 *
 * Discriminated union on the `mode` field. Each mode selects a different
 * execution isolation strategy.
 */
export type NodeStepRunnerFactoryOptions =
  | InProcessStepRunnerOptions
  | PiscinaStepRunnerOptions
  | ChildProcessStepRunnerOptions
  | DockerStepRunnerOptions;

// ---------------------------------------------------------------------------
// Worker Contribution Manifest
// ---------------------------------------------------------------------------

/**
 * Reference to an extension package that a worker process should import.
 *
 * Fully serializable so it can be sent across process boundaries (e.g.,
 * worker_threads postMessage or child-process IPC).
 */
export interface WorkerContributionPackageRef {
  /** Package name for diagnostics. */
  readonly name: string;
  /** ESM import path resolvable inside the worker environment. */
  readonly importPath: string;
}

/**
 * Serializable manifest that tells an isolated worker process which extension
 * packages to import for tools and adapters.
 *
 * Designed to be JSON-safe so it can be transferred across process boundaries
 * without loss.
 */
export interface WorkerContributionManifest {
  /** Explicit packages whose server entrypoints are importable in the worker. */
  readonly packages: readonly WorkerContributionPackageRef[];
}
