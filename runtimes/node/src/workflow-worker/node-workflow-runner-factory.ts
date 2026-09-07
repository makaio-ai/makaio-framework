import { basename } from 'node:path';
import type {
  IWorkflowRunner,
  StepRunnerBusAuth,
  StepRunnerPlatformDefaults,
  WorkerContributionManifest,
} from '@makaio/contracts';
import { WorkerSubjects } from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  ExecutionAttemptAuthority,
  WorkflowStorageSubjects,
  type ExecutionAttemptRepository,
  type WorkflowAttemptOutcome,
  type WorkflowMaterializationSpecResolver,
} from '@makaio/subsystem-workflow-engine';
import type { WorkflowRunnerBootOptions } from '../boot-types.js';
import type { WorkflowWorkerEntryMode } from './worker-entry-resolver.js';
import { ThinWorkflowPiscinaRunner } from './thin-workflow-piscina-runner.js';
import { resolveWorkflowWorkerEntry } from './worker-entry-resolver.js';
import { WorkerRunner } from './worker-runner.js';
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
   * explicit runner object. Also used by Worker mode when no explicit
   * dispatch function is supplied, and reads portable owner context for
   * path-backed Worker executions. Ignored for Piscina mode.
   */
  readonly bus?: IMakaioBus;
  /**
   * Injected execution attempt persistence port.
   *
   * Required when `workflowRunner.mode` is `'worker'`. Threaded
   * through to the workflow engine service options so the Authority
   * service can delegate durable decisions.
   */
  readonly executionAttemptRepository?: ExecutionAttemptRepository<WorkflowAttemptOutcome>;
  /** Explicit creation-time bootstrap budget, required whenever a repository is injected. */
  readonly executionAttemptBootstrapTimeoutMs?: number;
  /** Host-owned resolvers for portable path-backed workflow starts. */
  readonly workflowMaterializationSpecResolvers?: readonly WorkflowMaterializationSpecResolver[];
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
  /**
   * Injected execution attempt persistence port.
   *
   * Forwarded whenever the host supplies it, independently of runner mode.
   */
  readonly executionAttemptRepository?: ExecutionAttemptRepository<WorkflowAttemptOutcome>;
  /**
   * Execution attempt Authority constructed from the injected repository.
   *
   * Present whenever the host supplies a repository and bootstrap budget.
   * Shared between an Authority-backed runner (for attempt creation before dispatch) and
   * the workflow engine service (for outcome commitment).
   */
  readonly executionAttemptAuthority?: ExecutionAttemptAuthority<WorkflowAttemptOutcome>;
  /** Host-owned resolvers forwarded to the workflow engine service. */
  readonly workflowMaterializationSpecResolvers?: readonly WorkflowMaterializationSpecResolver[];
}

/**
 * Create the default empty worker contribution manifest.
 * @returns A fresh manifest instance for isolated runner options.
 */
function createEmptyWorkerContributionManifest(): WorkerContributionManifest {
  return { contributionRefs: [] };
}

/**
 * Compose workflow engine options for workflow-level execution.
 * @param params - Runtime module, bus, platform, and optional workflow runner.
 * @returns Options suitable for `createWorkflowEnginePackage`.
 */
export function createNodeWorkflowRunnerPackageOptions(
  params: CreateNodeWorkflowRunnerPackageOptionsParams,
): NodeWorkflowRunnerPackageOptions {
  // Construction gate: Worker mode requires an injected repository.
  if (params.workflowRunner?.mode === 'worker' && !params.executionAttemptRepository) {
    throw new Error(
      `Worker dispatch mode requires an ExecutionAttemptRepository. ` +
        `Pass 'executionAttemptRepository' to createNodeWorkflowRunnerPackageOptions ` +
        `when workflowRunner.mode is 'worker'.`,
    );
  }

  // Create the Authority early so it can be shared between the runner
  // (attempt creation before dispatch) and the engine service (outcome commitment).
  let executionAttemptAuthority: ExecutionAttemptAuthority<WorkflowAttemptOutcome> | undefined;
  if (params.executionAttemptRepository) {
    const bootstrapTimeoutMs = params.executionAttemptBootstrapTimeoutMs;
    if (bootstrapTimeoutMs === undefined) {
      throw new Error('An ExecutionAttemptRepository requires executionAttemptBootstrapTimeoutMs');
    }
    executionAttemptAuthority = new ExecutionAttemptAuthority(params.executionAttemptRepository, {
      bootstrapTimeoutMs,
    });
  }

  const defaultWorkerEntryMode: WorkflowWorkerEntryMode =
    basename(params.runtimeModuleDir) === 'src' ? 'source' : 'dist';
  const workflowRunner = createNodeWorkflowRunner({
    moduleDir: params.runtimeModuleDir,
    defaultWorkerEntryMode,
    runner: params.workflowRunner,
    bus: params.bus,
    authority: executionAttemptAuthority,
  });

  return {
    ...(workflowRunner !== undefined && { workflowRunner }),
    executorConfig: {
      busUrl: params.busUrl,
      busAuth: { kind: 'none' },
      platformDefaults: params.platformDefaults,
      makaioHome: params.makaioHome,
    },
    ...(params.executionAttemptRepository !== undefined && {
      executionAttemptRepository: params.executionAttemptRepository,
    }),
    ...(executionAttemptAuthority !== undefined && {
      executionAttemptAuthority,
    }),
    ...(params.workflowMaterializationSpecResolvers !== undefined && {
      workflowMaterializationSpecResolvers: params.workflowMaterializationSpecResolvers,
    }),
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
   * omitted. Also required for `'worker'` mode when no explicit dispatch
   * function is supplied, and for reading portable owner context before
   * path-backed Worker dispatch. Ignored for Piscina mode.
   */
  readonly bus?: IMakaioBus;
  /**
   * Execution attempt Authority injected into Worker runners.
   *
   * Required when `runner.mode` is `'worker'`. The runner uses this
   * to create attempts before dispatch and wait for committed outcomes.
   */
  readonly authority?: ExecutionAttemptAuthority<WorkflowAttemptOutcome>;
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

    case 'worker': {
      if (params.authority === undefined) {
        throw new Error(
          `WorkerRunner requires an ExecutionAttemptAuthority. ` +
            `Pass 'authority' to createNodeWorkflowRunner when runner.mode is 'worker'.`,
        );
      }
      const bus = params.bus;
      const dispatch =
        runner.dispatch ??
        (bus === undefined
          ? undefined
          : (request, signal) =>
              bus.request(
                WorkerSubjects.dispatch,
                {
                  executionAttemptId: request.executionAttemptId,
                  config: request.config,
                  manifest: request.manifest,
                  requirements: request.requirements,
                  metadata: request.metadata,
                },
                { signal },
              ));
      if (dispatch === undefined) {
        throw new Error(
          `WorkerRunner requires either a dispatch function or a bus instance. ` +
            `Pass 'bus' to createNodeWorkflowRunner when runner.mode is 'worker'.`,
        );
      }
      return new WorkerRunner({
        dispatch,
        authority: params.authority,
        ...(bus !== undefined && {
          readRunContext: async (executionId: string, signal: AbortSignal) =>
            (await bus.request(WorkflowStorageSubjects.getRunContext, { executionId }, { signal })).runContext,
        }),
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
        ...(runner.resolveWorkspaceRoot !== undefined && { resolveWorkspaceRoot: runner.resolveWorkspaceRoot }),
        maxConcurrency: runner.maxConcurrency,
        idleTimeoutMs: runner.idleTimeoutMs,
      });
    }
  }
}
