import { basename, resolve } from 'node:path';
import type { IStepRunner, IWorkflowRunner, StepRunnerBusAuth, StepRunnerPlatformDefaults } from '@makaio/contracts';
import type { WorkflowRunnerBootOptions } from '../boot-types.js';
import type { NodeStepRunnerFactoryOptions, WorkerContributionManifest } from './types.js';
import { PiscinaStepRunner } from './piscina-step-runner.js';
import { ChildProcessStepRunner } from './child-process-step-runner.js';
import { DockerStepRunner } from './docker-step-runner.js';
import { resolveWorkerEntry, type WorkerEntryMode } from './worker-entry-resolver.js';
import { WorkflowPiscinaRunner } from '../workflow-worker/workflow-piscina-runner.js';
import { resolveWorkflowWorkerEntry } from '../workflow-worker/worker-entry-resolver.js';
import { WorkerNodeRunner } from '../workflow-worker/worker-node-runner.js';

/** Internal configuration retained for legacy step-runner tests and migration work. */
type InternalWorkflowStepRunnerOptions =
  | {
      readonly mode?: 'in-process';
      readonly busAuth?: StepRunnerBusAuth;
    }
  | {
      readonly mode: 'piscina' | 'child-process';
      readonly manifest?: WorkerContributionManifest;
      readonly workerEntry?: string;
      readonly workerEntryMode?: WorkerEntryMode;
      readonly busAuth?: StepRunnerBusAuth;
      readonly maxConcurrency?: number;
      readonly idleTimeoutMs?: number;
    }
  | {
      readonly mode: 'docker';
      readonly imageName: string;
      readonly networkMode?: string;
      readonly manifest?: WorkerContributionManifest;
      readonly workerEntry?: string;
      readonly workerEntryMode?: WorkerEntryMode;
      readonly busAuth?: StepRunnerBusAuth;
    };

/** Parameters for resolving workflow step runner factory options at boot. */
export interface ResolveWorkflowStepRunnerFactoryOptionsParams {
  /** Runtime bus URL exposed to isolated workers. */
  readonly busUrl: string;
  /** Package root used to resolve source/dist worker entries. */
  readonly packageRoot: string;
  /** Platform defaults forwarded to executor and runner factory options. */
  readonly platformDefaults: StepRunnerPlatformDefaults;
  /** Optional internal step runner override. */
  readonly runner?: InternalWorkflowStepRunnerOptions;
  /** Source/dist worker entry mode inferred from the current runtime build. */
  readonly defaultWorkerEntryMode: WorkerEntryMode;
}

/** Parameters for composing workflow engine runner package options. */
export interface CreateNodeWorkflowStepRunnerPackageOptionsParams {
  /** Runtime bus URL exposed to isolated workers. */
  readonly busUrl: string;
  /** Directory of the active runtime module (`src` in dev, `dist` in builds). */
  readonly runtimeModuleDir: string;
  /** Platform defaults forwarded to executor and runner factory options. */
  readonly platformDefaults: StepRunnerPlatformDefaults;
  /** Optional internal legacy step runner override. */
  readonly runner?: InternalWorkflowStepRunnerOptions;
  /** Optional boot-level workflow-level runner configuration. */
  readonly workflowRunner?: WorkflowRunnerBootOptions;
  /** Makaio data-home path forwarded to the executor config. */
  readonly makaioHome?: string;
}

/** Workflow engine package options produced by Node runtime composition. */
export interface NodeWorkflowStepRunnerPackageOptions {
  /** Optional internal legacy step runner; runtime boot no longer configures this. */
  readonly stepRunner?: IStepRunner;
  /**
   * Optional workflow-level runner for full-execution dispatch.
   * When present, each new workflow execution is delegated to this runner
   * instead of the in-process DAG scheduler.
   */
  readonly workflowRunner?: IWorkflowRunner;
  /** Executor config shared by in-process and isolated modes. */
  readonly executorConfig: {
    /** Runtime bus URL exposed to isolated workers. */
    readonly busUrl: string;
    /** Bus authentication forwarded to runner configs. */
    readonly busAuth: NonNullable<NodeStepRunnerFactoryOptions['busAuth']>;
    /** Platform defaults forwarded to executor and runner configs. */
    readonly platformDefaults: StepRunnerPlatformDefaults;
    /** Makaio data-home path forwarded to workflow workers. */
    readonly makaioHome?: string;
  };
}

/**
 * Create the default empty worker contribution manifest.
 * @returns A fresh manifest instance for isolated runner options.
 */
function createEmptyWorkerContributionManifest(): WorkerContributionManifest {
  return { packages: [] };
}

/**
 * Resolve typed Node runner factory options from runtime boot options.
 *
 * Kept pure so boot composition can be tested without starting the full runtime.
 * Defaults to `in-process`, preserving existing behavior when no runner option is supplied.
 * @param params - Bus, platform, package root, and optional runner override.
 * @returns Factory options for {@link createNodeStepRunner}.
 */
export function resolveWorkflowStepRunnerFactoryOptions(
  params: ResolveWorkflowStepRunnerFactoryOptionsParams,
): NodeStepRunnerFactoryOptions {
  const runner = params.runner;
  const base = {
    busUrl: params.busUrl,
    busAuth: runner?.busAuth ?? { kind: 'none' as const },
    cwd: params.platformDefaults.cwd,
    platformDefaults: params.platformDefaults,
  };

  if (!runner || runner.mode === undefined || runner.mode === 'in-process') {
    return { mode: 'in-process', ...base };
  }

  switch (runner.mode) {
    case 'piscina': {
      return {
        mode: runner.mode,
        ...base,
        manifest: runner.manifest ?? createEmptyWorkerContributionManifest(),
        workerEntry: resolveBootWorkerEntry(params, runner),
        maxConcurrency: runner.maxConcurrency,
        idleTimeoutMs: runner.idleTimeoutMs,
      };
    }
    case 'child-process': {
      return {
        mode: runner.mode,
        ...base,
        manifest: runner.manifest ?? createEmptyWorkerContributionManifest(),
        workerEntry: resolveBootWorkerEntry(params, runner),
      };
    }
    case 'docker': {
      return {
        mode: runner.mode,
        ...base,
        manifest: runner.manifest ?? createEmptyWorkerContributionManifest(),
        workerEntry: resolveBootWorkerEntry(params, runner),
        imageName: runner.imageName,
        networkMode: runner.networkMode,
      };
    }
  }
}

/**
 * Compose workflow engine package runner options from Node runtime boot context.
 * @param params - Runtime module, bus, platform, and optional runner overrides.
 * @returns Options suitable for `createWorkflowEnginePackage`.
 */
export function createNodeWorkflowStepRunnerPackageOptions(
  params: CreateNodeWorkflowStepRunnerPackageOptionsParams,
): NodeWorkflowStepRunnerPackageOptions {
  const packageRoot = resolve(params.runtimeModuleDir, '..');
  const defaultWorkerEntryMode: WorkerEntryMode = basename(params.runtimeModuleDir) === 'src' ? 'source' : 'dist';

  const factoryOptions = resolveWorkflowStepRunnerFactoryOptions({
    busUrl: params.busUrl,
    packageRoot,
    platformDefaults: params.platformDefaults,
    defaultWorkerEntryMode,
    runner: params.runner,
  });
  const stepRunner = createNodeStepRunner(factoryOptions);
  const workflowRunner = createNodeWorkflowRunner({
    packageRoot,
    defaultWorkerEntryMode,
    runner: params.workflowRunner,
  });
  const executorConfig = {
    busUrl: params.busUrl,
    busAuth: factoryOptions.busAuth ?? { kind: 'none' as const },
    platformDefaults: params.platformDefaults,
    makaioHome: params.makaioHome,
  };

  return {
    ...(stepRunner !== undefined && { stepRunner }),
    ...(workflowRunner !== undefined && { workflowRunner }),
    executorConfig,
  };
}

/**
 * Compose workflow engine options for workflow-level execution only.
 * @param params - Runtime module, bus, platform, and optional workflow runner.
 * @returns Options suitable for `createWorkflowEnginePackage`.
 */
export function createNodeWorkflowRunnerPackageOptions(
  params: Omit<CreateNodeWorkflowStepRunnerPackageOptionsParams, 'runner'>,
): NodeWorkflowStepRunnerPackageOptions {
  const packageRoot = resolve(params.runtimeModuleDir, '..');
  const defaultWorkerEntryMode: WorkerEntryMode = basename(params.runtimeModuleDir) === 'src' ? 'source' : 'dist';
  const workflowRunner = createNodeWorkflowRunner({
    packageRoot,
    defaultWorkerEntryMode,
    runner: params.workflowRunner,
  });

  return {
    ...(workflowRunner !== undefined && { workflowRunner }),
    executorConfig: {
      busUrl: params.busUrl,
      busAuth: { kind: 'none' },
      platformDefaults: params.platformDefaults,
      makaioHome: params.makaioHome,
    },
  };
}

/**
 * Resolve an explicit or source/dist worker entry from boot runner options.
 * @param params - Package root and default worker entry mode.
 * @param runner - Isolated runner boot options.
 * @returns Absolute worker entry path.
 */
function resolveBootWorkerEntry(
  params: Pick<ResolveWorkflowStepRunnerFactoryOptionsParams, 'defaultWorkerEntryMode' | 'packageRoot'>,
  runner: Extract<InternalWorkflowStepRunnerOptions, { mode: 'piscina' | 'child-process' | 'docker' }>,
): string {
  return (
    runner.workerEntry ??
    resolveWorkerEntry({
      packageRoot: params.packageRoot,
      mode: runner.workerEntryMode ?? params.defaultWorkerEntryMode,
    })
  );
}

/**
 * Create a step runner based on the Node runtime configuration.
 *
 * Returns `undefined` for `in-process` mode — the workflow engine falls back
 * to its built-in in-process execution. For all isolation modes, returns a
 * concrete runner instance:
 * - `piscina`: Worker-thread pool via Piscina
 * - `child-process`: Isolated Node.js child processes
 * - `docker`: Docker containers for full OS-level isolation
 * @param options - Node step runner factory configuration.
 * @returns A step runner instance, or `undefined` to use the engine default.
 */
export function createNodeStepRunner(options: NodeStepRunnerFactoryOptions): IStepRunner | undefined {
  switch (options.mode) {
    case 'in-process':
      return undefined;
    case 'piscina':
      return new PiscinaStepRunner(options);
    case 'child-process':
      return new ChildProcessStepRunner(options);
    case 'docker':
      return new DockerStepRunner(options);
  }
}

/** Internal parameters for creating a Node workflow-level runner. */
interface CreateNodeWorkflowRunnerParams {
  /** Absolute path to the package root directory. */
  readonly packageRoot: string;
  /** Default worker entry mode (`'source'` in dev, `'dist'` in builds). */
  readonly defaultWorkerEntryMode: WorkerEntryMode;
  /** Optional boot-level workflow runner configuration. */
  readonly runner?: WorkflowRunnerBootOptions;
}

/**
 * Create a workflow-level runner based on the Node runtime configuration.
 *
 * Returns `undefined` for `in-process` mode (or when no runner is configured),
 * letting the workflow engine fall back to its built-in DAG scheduler.
 * Returns a {@link WorkflowPiscinaRunner} for `piscina` mode.
 * Returns a {@link WorkerNodeRunner} for `worker-node` mode.
 * @param params - Package root, entry mode, and optional runner configuration.
 * @returns A workflow runner instance, or `undefined` to use the engine default.
 */
export function createNodeWorkflowRunner(params: CreateNodeWorkflowRunnerParams): IWorkflowRunner | undefined {
  const { runner } = params;
  if (!runner) {
    return undefined;
  }

  switch (runner.mode) {
    case undefined:
    case 'in-process':
      return undefined;

    case 'worker-node':
      return new WorkerNodeRunner({
        dispatch: runner.dispatch,
        ...(runner.manifest !== undefined && { manifest: runner.manifest }),
        ...(runner.requirements !== undefined && { requirements: runner.requirements }),
      });

    case 'piscina': {
      const workerEntry =
        runner.workerEntry ??
        resolveWorkflowWorkerEntry({
          packageRoot: params.packageRoot,
          mode: runner.workerEntryMode ?? params.defaultWorkerEntryMode,
        });

      return new WorkflowPiscinaRunner({
        workerEntry,
        manifest: runner.manifest ?? createEmptyWorkerContributionManifest(),
        maxConcurrency: runner.maxConcurrency,
        idleTimeoutMs: runner.idleTimeoutMs,
      });
    }
  }
}
