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

/** Fields every worker-thread task carries, whatever gate it runs behind. */
interface ThinWorkflowPiscinaTaskBase {
  /** Workflow worker configuration with source, inputs, and bus info. */
  readonly config: WorkflowWorkerConfig;
  /** Contribution manifest declaring which extension packages to load in workers. */
  readonly manifest: WorkerContributionManifest;
  /** Verified worker-local entrypoints matching `manifest.contributionRefs`. */
  readonly contributionEntrypoints: readonly string[];
}

/**
 * Task for a workflow run that no ExecutionAttempt owns.
 *
 * The host drove this run through {@link ThinWorkflowPiscinaRunner.run}, so
 * there is no attempt to register a runtime with and no start gate to pass.
 */
interface ThinWorkflowPiscinaRunnerTask extends ThinWorkflowPiscinaTaskBase {
  /** Discriminator selecting the attempt-free arm of the worker entrypoint. */
  readonly kind: 'unbound';
}

/**
 * Task for a workflow run an ExecutionAttempt owns.
 *
 * The attempt identifier is required, not optional: the thread registers its
 * runtime and admits the run against exactly this attempt before it composes
 * anything, and its `config.busAuth` is the attempt-scoped secret the
 * provisioning provider minted for that identity.
 */
interface ThinWorkflowPiscinaAttemptTask extends ThinWorkflowPiscinaTaskBase {
  /** Discriminator selecting the attempt-bound arm of the worker entrypoint. */
  readonly kind: 'attempt-bound';
  /** Authority-created attempt this thread registers its runtime for. */
  readonly executionAttemptId: string;
}

/** Every task shape the Piscina worker entrypoint accepts. */
type ThinWorkflowPiscinaTask = ThinWorkflowPiscinaRunnerTask | ThinWorkflowPiscinaAttemptTask;

/** Attempt identity a readiness-aware dispatch binds its worker thread to. */
export interface ThinWorkflowPiscinaAttemptBinding {
  /** Authority-created attempt the dispatched thread registers against. */
  readonly executionAttemptId: string;
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
  private pool: PiscinaPoolRunner<ThinWorkflowPiscinaTask, WorkflowRunResult> | undefined;

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
   * default, so per-request contribution sets from the Worker pool are
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
   * Execute an attempt-bound workflow and expose its readiness signal separately.
   *
   * The terminal result remains the {@link IWorkflowRunner} contract. The ready
   * promise resolves once the worker thread's own
   * `execution-attempt.runtime.register` reply came back, so readiness here
   * means the authority accepted that runtime rather than that a thread booted.
   *
   * The attempt binding is required because readiness has no meaning without
   * it: a thread with no attempt registers nothing, posts no ready message, and
   * would leave this promise to be rejected by the run's own settlement.
   * @param config - Full workflow worker configuration with source, inputs, and bus info.
   * @param signal - AbortSignal for cooperative cancellation.
   * @param manifest - Optional per-call manifest override.
   * @param attempt - Attempt identity the dispatched thread registers against.
   * @returns Terminal result and readiness promises for this worker run.
   */
  public runWithReadiness(
    config: WorkflowWorkerConfig,
    signal: AbortSignal,
    manifest: WorkerContributionManifest | undefined,
    attempt: ThinWorkflowPiscinaAttemptBinding,
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
        if (message.executionAttemptId !== attempt.executionAttemptId) return;
        if (message.executionId !== config.executionId || message.cancelSubject !== config.cancelSubject) return;
        settledReady = true;
        cleanupReadyListener?.();
        resolve(message);
      });
    });

    const resolvedManifest = manifest ?? this.manifest;
    const result = this.materializeTask(config, resolvedManifest, signal).then((task) =>
      pool.run({ ...task, kind: 'attempt-bound', executionAttemptId: attempt.executionAttemptId }, signal),
    );
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
   *
   * The task is returned as the `unbound` arm; the readiness-aware path
   * re-stamps it `attempt-bound` with its attempt identity afterwards, so the
   * attempt identity never becomes an optional field on the shape the
   * attempt-free path also uses.
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
      return { kind: 'unbound', config, manifest, contributionEntrypoints: [] };
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
      kind: 'unbound',
      config: {
        ...config,
        source: { kind: 'path', path: runtimeContext.sourcePath },
      },
      manifest,
      contributionEntrypoints: runtimeContext.contributionEntrypoints,
    };
  }
}
