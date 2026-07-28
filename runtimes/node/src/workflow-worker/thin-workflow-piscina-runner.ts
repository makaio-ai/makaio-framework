import type { WorkflowWorkerConfig, WorkerContributionManifest } from '@makaio/contracts';
import type {
  IWorkflowRunner,
  ThinWorkflowPiscinaRunnerOptions,
  WorkflowRunnerCompletion,
  WorkflowRunResult,
} from './types.js';
import { isWorkflowWorkerReadyMessage, type WorkflowWorkerReadyMessage } from './worker-ready-message.js';
import { PiscinaPoolRunner } from './runtime/piscina-pool-runner.js';
import { materializeLocalDirectory } from './local-directory-materializer.js';

interface ThinWorkflowPiscinaRunnerTask {
  /** Workflow worker configuration with source, inputs, and bus info. */
  readonly config: WorkflowWorkerConfig;
  /** Contribution manifest declaring which extension packages to load in workers. */
  readonly manifest: WorkerContributionManifest;
  /** Verified worker-local entrypoints matching `manifest.contributionRefs`. */
  readonly contributionEntrypoints: readonly string[];
}

/** Result and readiness promises for one workflow worker dispatch. */
export interface ThinWorkflowPiscinaRunWithReadiness {
  /** Terminal workflow result returned by the worker. */
  readonly result: Promise<WorkflowRunResult>;
  /** Resolves when the worker bus is connected and cancellation routing is subscribed. */
  readonly ready: Promise<WorkflowWorkerReadyMessage>;
}

/**
 * Thin workflow runner that dispatches workflow orchestration to a Piscina
 * worker-thread pool.
 *
 * Each workflow invocation is handed off to a pooled worker thread running the
 * `workflow-worker/worker-entry.ts` entrypoint. The worker isolates DAG control
 * flow and worker-local toolsets, while agent/subagent execution is delegated to
 * the host runtime. The pool manages concurrency limits and idle thread reaping
 * automatically.
 */
export class ThinWorkflowPiscinaRunner implements IWorkflowRunner {
  private readonly manifest: WorkerContributionManifest;
  private pool: PiscinaPoolRunner<ThinWorkflowPiscinaRunnerTask, WorkflowRunResult> | undefined;

  /**
   * @param options - Piscina runner configuration including worker entry path
   *   and concurrency settings.
   */
  public constructor(private readonly options: ThinWorkflowPiscinaRunnerOptions) {
    this.manifest = options.manifest;
  }

  /**
   * Execute a complete workflow in a pooled worker thread.
   *
   * When `manifest` is provided it overrides the runner's construction-time
   * default, so per-request contribution sets from the WorkerNode pool are
   * applied correctly without requiring a new runner instance.
   * @param config - Full workflow worker configuration with source, inputs, and bus info.
   * @param signal - AbortSignal for cooperative cancellation.
   * @param manifest - Optional per-call manifest override.
   * @returns Uncommitted completion; the host executor owns finalization.
   */
  public async run(
    config: WorkflowWorkerConfig,
    signal: AbortSignal,
    manifest?: WorkerContributionManifest,
  ): Promise<WorkflowRunnerCompletion> {
    this.pool ??= new PiscinaPoolRunner(this.options);
    const resolvedManifest = manifest ?? this.manifest;
    const task = await this.materializeTask(config, resolvedManifest, signal);
    const result = await this.pool.run(task, signal);
    return { state: 'uncommitted', result };
  }

  /**
   * Execute a workflow and expose the worker bus readiness signal separately.
   *
   * The terminal result remains the {@link IWorkflowRunner} contract. The ready
   * promise is used by {@link PiscinaThinWorkflowProvider} so pool lifecycle
   * `ready` is not emitted before the worker has connected its bus and subscribed
   * to cancellation routing.
   * @param config - Full workflow worker configuration with source, inputs, and bus info.
   * @param signal - AbortSignal for cooperative cancellation.
   * @param manifest - Optional per-call manifest override.
   * @returns Terminal result and readiness promises for this worker run.
   */
  public runWithReadiness(
    config: WorkflowWorkerConfig,
    signal: AbortSignal,
    manifest?: WorkerContributionManifest,
  ): ThinWorkflowPiscinaRunWithReadiness {
    this.pool ??= new PiscinaPoolRunner(this.options);
    const pool = this.pool;

    let cleanupReadyListener: (() => void) | undefined;
    let settledReady = false;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<WorkflowWorkerReadyMessage>((resolve, reject) => {
      rejectReady = reject;
      cleanupReadyListener = pool.onMessage((message) => {
        if (!isWorkflowWorkerReadyMessage(message)) return;
        if (message.executionId !== config.executionId || message.cancelSubject !== config.cancelSubject) return;
        settledReady = true;
        cleanupReadyListener?.();
        resolve(message);
      });
    });

    const resolvedManifest = manifest ?? this.manifest;
    const result = this.materializeTask(config, resolvedManifest, signal).then((task) => pool.run(task, signal));
    void result.then(
      () => {
        if (settledReady) return;
        settledReady = true;
        cleanupReadyListener?.();
        rejectReady(new Error(`Workflow worker completed before ready signal: ${config.executionId}`));
      },
      (error: unknown) => {
        if (settledReady) return;
        settledReady = true;
        cleanupReadyListener?.();
        rejectReady(error instanceof Error ? error : new Error(String(error)));
      },
    );

    return { result, ready };
  }

  /**
   * Destroy the thread pool and release all worker threads.
   */
  public async dispose(): Promise<void> {
    await this.pool?.dispose();
  }

  /**
   * Realize portable filesystem references before transferring a task to
   * Piscina. Worker threads receive only verified absolute paths, never an
   * Authority-relative source or unchecked contribution package path.
   * @param config - Portable worker configuration.
   * @param manifest - Exact contribution identities for this execution.
   * @param signal - Cancellation signal for the dispatch.
   * @returns A worker-thread task containing verified local paths.
   */
  private async materializeTask(
    config: WorkflowWorkerConfig,
    manifest: WorkerContributionManifest,
    signal: AbortSignal,
  ): Promise<ThinWorkflowPiscinaRunnerTask> {
    signal.throwIfAborted();
    const requiresMaterialization = config.source.kind === 'path' || manifest.contributionRefs.length > 0;
    if (!requiresMaterialization) {
      return { config, manifest, contributionEntrypoints: [] };
    }

    const spec = config.materializationSpec;
    if (spec?.kind !== 'local-directory') {
      throw new Error(
        'ThinWorkflowPiscinaRunner requires a local-directory materialization spec for path-backed workflows or declared contributions.',
      );
    }
    if (this.options.resolveWorkspaceRoot === undefined) {
      throw new Error(
        'ThinWorkflowPiscinaRunner requires a host workspace-root resolver for local-directory materialization.',
      );
    }

    const runtimeContext = await materializeLocalDirectory(spec, manifest.contributionRefs, {
      resolveWorkspaceRoot: this.options.resolveWorkspaceRoot,
    });
    signal.throwIfAborted();
    if (config.source.kind !== 'path') {
      throw new Error('local-directory materialization requires a path-backed workflow source.');
    }
    return {
      config: {
        ...config,
        source: { kind: 'path', path: runtimeContext.sourcePath },
      },
      manifest,
      contributionEntrypoints: runtimeContext.contributionEntrypoints,
    };
  }
}
