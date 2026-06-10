import { basename } from 'node:path';
import type {
  IWorkflowRunner,
  StepRunnerBusAuth,
  StepRunnerPlatformDefaults,
  WorkerContributionManifest,
} from '@makaio/contracts';
import { WorkerNodeSubjects } from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';
import type { WorkflowRunnerBootOptions } from '../boot-types.js';
import type { WorkflowWorkerEntryMode } from './worker-entry-resolver.js';
import { ThinWorkflowPiscinaRunner } from './thin-workflow-piscina-runner.js';
import { resolveWorkflowWorkerEntry } from './worker-entry-resolver.js';
import { WorkerNodeRunner } from './worker-node-runner.js';
import { InProcessWorkflowRunner } from './in-process-workflow-runner.js';

/** Parameters for composing workflow engine runner package options. */
export interface CreateNodeWorkflowRunnerPackageOptionsParams {
  /** Runtime bus URL exposed to isolated workers. */
  readonly busUrl: string;
  /** Directory of the active runtime module (`src` in dev, `dist` in builds). */
  readonly runtimeModuleDir: string;
  /** Platform defaults forwarded to executor and worker configs. */
  readonly platformDefaults: StepRunnerPlatformDefaults;
  /** Optional boot-level workflow-level runner configuration. */
  readonly workflowRunner?: WorkflowRunnerBootOptions;
  /** Makaio data-home path forwarded to the executor config. */
  readonly makaioHome?: string;
  /**
   * Host-owned bus instance forwarded to in-process runner construction.
   *
   * Required when `workflowRunner.mode` is `'in-process'` or omitted on an
   * explicit runner object. Also used by WorkerNode mode when no explicit
   * dispatch function is supplied. Ignored for Piscina mode.
   */
  readonly bus?: IMakaioBus;
}

/** Workflow engine package options produced by Node runtime composition. */
export interface NodeWorkflowRunnerPackageOptions {
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
    /** Bus authentication forwarded to workflow worker configs. */
    readonly busAuth: StepRunnerBusAuth;
    /** Platform defaults forwarded to executor and worker configs. */
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
 * Compose workflow engine options for workflow-level execution.
 * @param params - Runtime module, bus, platform, and optional workflow runner.
 * @returns Options suitable for `createWorkflowEnginePackage`.
 */
export function createNodeWorkflowRunnerPackageOptions(
  params: CreateNodeWorkflowRunnerPackageOptionsParams,
): NodeWorkflowRunnerPackageOptions {
  const defaultWorkerEntryMode: WorkflowWorkerEntryMode =
    basename(params.runtimeModuleDir) === 'src' ? 'source' : 'dist';
  const workflowRunner = createNodeWorkflowRunner({
    moduleDir: params.runtimeModuleDir,
    defaultWorkerEntryMode,
    runner: params.workflowRunner,
    bus: params.bus,
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

/** Internal parameters for creating a Node workflow-level runner. */
interface CreateNodeWorkflowRunnerParams {
  /**
   * Absolute path to the directory that contains the running boot module.
   * Passed directly to `resolveWorkflowWorkerEntry` as `moduleDir`.
   */
  readonly moduleDir: string;
  /** Default worker entry mode (`'source'` in dev, `'dist'` in builds). */
  readonly defaultWorkerEntryMode: WorkflowWorkerEntryMode;
  /** Optional boot-level workflow runner configuration. */
  readonly runner?: WorkflowRunnerBootOptions;
  /**
   * Host-owned bus instance forwarded to {@link InProcessWorkflowRunner}.
   *
   * Required when `runner` is present and its `mode` is `'in-process'` or
   * omitted. Also required for `'worker-node'` mode when no explicit dispatch
   * function is supplied. Ignored for Piscina mode.
   */
  readonly bus?: IMakaioBus;
}

/**
 * Create a workflow-level runner based on the Node runtime configuration.
 *
 * Returns `undefined` when no runner is configured, letting the workflow engine
 * fall back to its built-in DAG scheduler. Explicit runner modes create the
 * matching workflow-level execution strategy.
 * @param params - Module directory, entry mode, optional runner configuration, and optional bus.
 * @returns A workflow runner instance, or `undefined` to use the engine default.
 */
export function createNodeWorkflowRunner(params: CreateNodeWorkflowRunnerParams): IWorkflowRunner | undefined {
  const { runner } = params;
  if (!runner) {
    return undefined;
  }

  switch (runner.mode) {
    case undefined:
    case 'in-process': {
      if (params.bus === undefined) {
        throw new Error(
          `InProcessWorkflowRunner requires a bus instance. ` +
            `Pass 'bus' to createNodeWorkflowRunner when runner.mode is 'in-process'.`,
        );
      }
      return new InProcessWorkflowRunner({ bus: params.bus });
    }

    case 'worker-node': {
      const bus = params.bus;
      const dispatch =
        runner.dispatch ??
        (bus === undefined
          ? undefined
          : (request, signal) =>
              bus.request(
                WorkerNodeSubjects.dispatch,
                {
                  config: request.config,
                  manifest: request.manifest,
                  requirements: request.requirements,
                  metadata: request.metadata,
                },
                { signal },
              ));
      if (dispatch === undefined) {
        throw new Error(
          `WorkerNodeRunner requires either a dispatch function or a bus instance. ` +
            `Pass 'bus' to createNodeWorkflowRunner when runner.mode is 'worker-node'.`,
        );
      }
      return new WorkerNodeRunner({
        dispatch,
        ...(runner.manifest !== undefined && { manifest: runner.manifest }),
        ...(runner.requirements !== undefined && { requirements: runner.requirements }),
      });
    }

    case 'piscina': {
      const workerEntry =
        runner.workerEntry ??
        resolveWorkflowWorkerEntry({
          moduleDir: params.moduleDir,
          mode: runner.workerEntryMode ?? params.defaultWorkerEntryMode,
        });

      return new ThinWorkflowPiscinaRunner({
        workerEntry,
        manifest: runner.manifest ?? createEmptyWorkerContributionManifest(),
        maxConcurrency: runner.maxConcurrency,
        idleTimeoutMs: runner.idleTimeoutMs,
      });
    }
  }
}
