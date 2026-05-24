import { basename, resolve } from 'node:path';
import type { IStepRunner, StepRunnerPlatformDefaults } from '@makaio/contracts';
import type { WorkflowStepRunnerBootOptions } from '../boot-types.js';
import type { NodeStepRunnerFactoryOptions, WorkerContributionManifest } from './types.js';
import { PiscinaStepRunner } from './piscina-step-runner.js';
import { ChildProcessStepRunner } from './child-process-step-runner.js';
import { DockerStepRunner } from './docker-step-runner.js';
import { resolveWorkerEntry, type WorkerEntryMode } from './worker-entry-resolver.js';

/** Parameters for resolving workflow step runner factory options at boot. */
export interface ResolveWorkflowStepRunnerFactoryOptionsParams {
  /** Runtime bus URL exposed to isolated workers. */
  readonly busUrl: string;
  /** Package root used to resolve source/dist worker entries. */
  readonly packageRoot: string;
  /** Platform defaults forwarded to executor and runner factory options. */
  readonly platformDefaults: StepRunnerPlatformDefaults;
  /** Source/dist worker entry mode inferred from the current runtime build. */
  readonly defaultWorkerEntryMode: WorkerEntryMode;
  /** Optional boot-level runner override. */
  readonly runner?: WorkflowStepRunnerBootOptions;
}

/** Parameters for composing workflow engine runner package options. */
export interface CreateNodeWorkflowStepRunnerPackageOptionsParams {
  /** Runtime bus URL exposed to isolated workers. */
  readonly busUrl: string;
  /** Directory of the active runtime module (`src` in dev, `dist` in builds). */
  readonly runtimeModuleDir: string;
  /** Platform defaults forwarded to executor and runner factory options. */
  readonly platformDefaults: StepRunnerPlatformDefaults;
  /** Optional boot-level runner override. */
  readonly runner?: WorkflowStepRunnerBootOptions;
}

/** Workflow engine package options produced by Node runtime composition. */
export interface NodeWorkflowStepRunnerPackageOptions {
  /** Optional custom step runner; omitted for in-process mode. */
  readonly stepRunner?: IStepRunner;
  /** Executor config shared by in-process and isolated modes. */
  readonly executorConfig: {
    /** Runtime bus URL exposed to isolated workers. */
    readonly busUrl: string;
    /** Bus authentication forwarded to runner configs. */
    readonly busAuth: NonNullable<NodeStepRunnerFactoryOptions['busAuth']>;
    /** Platform defaults forwarded to executor and runner configs. */
    readonly platformDefaults: StepRunnerPlatformDefaults;
  };
}

const EMPTY_WORKER_CONTRIBUTION_MANIFEST: WorkerContributionManifest = Object.freeze({ packages: Object.freeze([]) });

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
        manifest: runner.manifest ?? EMPTY_WORKER_CONTRIBUTION_MANIFEST,
        workerEntry: resolveBootWorkerEntry(params, runner),
        maxConcurrency: runner.maxConcurrency,
        idleTimeoutMs: runner.idleTimeoutMs,
      };
    }
    case 'child-process': {
      return {
        mode: runner.mode,
        ...base,
        manifest: runner.manifest ?? EMPTY_WORKER_CONTRIBUTION_MANIFEST,
        workerEntry: resolveBootWorkerEntry(params, runner),
      };
    }
    case 'docker': {
      return {
        mode: runner.mode,
        ...base,
        manifest: runner.manifest ?? EMPTY_WORKER_CONTRIBUTION_MANIFEST,
        workerEntry: resolveBootWorkerEntry(params, runner),
        imageName: runner.imageName,
        networkMode: runner.networkMode,
      };
    }
  }
}

/**
 * Compose workflow engine package runner options from Node runtime boot context.
 * @param params - Runtime module, bus, platform, and optional runner override.
 * @returns Options suitable for `createWorkflowEnginePackage`.
 */
export function createNodeWorkflowStepRunnerPackageOptions(
  params: CreateNodeWorkflowStepRunnerPackageOptionsParams,
): NodeWorkflowStepRunnerPackageOptions {
  const factoryOptions = resolveWorkflowStepRunnerFactoryOptions({
    busUrl: params.busUrl,
    packageRoot: resolve(params.runtimeModuleDir, '..'),
    platformDefaults: params.platformDefaults,
    defaultWorkerEntryMode: basename(params.runtimeModuleDir) === 'src' ? 'source' : 'dist',
    runner: params.runner,
  });
  const stepRunner = createNodeStepRunner(factoryOptions);
  const executorConfig = {
    busUrl: params.busUrl,
    busAuth: factoryOptions.busAuth ?? { kind: 'none' as const },
    platformDefaults: params.platformDefaults,
  };

  return stepRunner ? { stepRunner, executorConfig } : { executorConfig };
}

/**
 * Resolve an explicit or source/dist worker entry from boot runner options.
 * @param params - Package root and default worker entry mode.
 * @param runner - Isolated runner boot options.
 * @returns Absolute worker entry path.
 */
function resolveBootWorkerEntry(
  params: Pick<ResolveWorkflowStepRunnerFactoryOptionsParams, 'defaultWorkerEntryMode' | 'packageRoot'>,
  runner: Extract<WorkflowStepRunnerBootOptions, { mode: 'piscina' | 'child-process' | 'docker' }>,
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
