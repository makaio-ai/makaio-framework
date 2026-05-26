import type { StepRunnerBusAuth, StepRunnerPlatformDefaults, WorkerContributionManifest } from '@makaio/contracts';

export type { WorkerContributionManifest, WorkerContributionPackageRef } from '@makaio/contracts';

// ---------------------------------------------------------------------------
// Shared base fields for all runner modes
// ---------------------------------------------------------------------------

/** Base configuration fields shared by all step runner modes. */
interface NodeStepRunnerBaseOptions {
  /** Bus server WebSocket URL for runner worker connections. */
  readonly busUrl?: string;
  /** Bus authentication strategy for runner worker connections. */
  readonly busAuth?: StepRunnerBusAuth;
  /** Platform defaults forwarded from the runtime composition root. */
  readonly platformDefaults: StepRunnerPlatformDefaults;
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
