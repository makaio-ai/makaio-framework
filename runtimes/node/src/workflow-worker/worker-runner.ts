import { randomUUID } from 'node:crypto';
import type {
  IWorkflowRunner,
  WorkerContributionManifest,
  WorkerDispatch,
  WorkerRequirements,
  WorkflowRunnerCompletion,
  WorkflowRunnerRunOptions,
  WorkflowRunContext,
  WorkflowWorkerConfig,
} from '@makaio/contracts';
import type { ExecutionAttemptAuthority, WorkflowAttemptOutcome } from '@makaio/subsystem-workflow-engine';
import {
  buildWorkflowAttemptInstruction,
  runAuthorityDispatchedAttempt,
  toCommittedWorkflowRunnerResult,
} from '@makaio/subsystem-workflow-engine';

/**
 * Construction options for {@link WorkerRunner}.
 */
export interface WorkerRunnerOptions {
  /**
   * Dispatch seam injected by the host composition root.
   *
   * Product hosts wire this to `workerPool.dispatch` or another implementation.
   * Framework code calls through this seam without coupling to any pool.
   */
  readonly dispatch: WorkerDispatch;
  /**
   * Execution attempt Authority used to create attempts before dispatch and
   * wait for committed outcomes after dispatch returns.
   *
   * Required for authority-committed completions. When absent, the runner
   * cannot create attempts or wait for durable outcomes.
   */
  readonly authority: ExecutionAttemptAuthority<WorkflowAttemptOutcome>;
  /**
   * Read portable owner input before creating a path-backed Attempt.
   * Self-contained source and definition configs need no storage lookup.
   * @param executionId - Workflow execution whose executable source is being frozen.
   * @param signal - Cancellation signal for the owner-context read.
   * @returns The portable owner context, or null when none was persisted.
   */
  readonly readRunContext?: (executionId: string, signal: AbortSignal) => Promise<WorkflowRunContext | null>;
  /**
   * Extension contribution manifest forwarded to dispatched workers.
   *
   * Omit this when the receiving dispatch layer should resolve the manifest
   * from the selected pool or execution scope.
   */
  readonly manifest?: WorkerContributionManifest;
  /**
   * Optional resource requirements forwarded to the pool dispatch.
   *
   * When provided, the receiving pool uses these to select a compatible
   * provider. Omit to accept any available pool.
   */
  readonly requirements?: WorkerRequirements;
}

/**
 * Workflow runner that delegates full workflow execution to a Worker
 * dispatch seam supplied by the host composition root.
 *
 * This class implements the {@link IWorkflowRunner} contract while remaining
 * product-agnostic. Concrete dispatch behavior (e.g. pool selection, provider
 * matching, manifest resolution) lives in the product-owned composition root
 * or `workerPool.dispatch` handler, not here.
 *
 * The runner creates an execution attempt through the injected Authority
 * before dispatch and waits for the committed outcome after dispatch returns.
 */
export class WorkerRunner implements IWorkflowRunner {
  /** The Attempt owner commits and converges results before runner completion. */
  public readonly terminalAuthority = 'authority';

  /**
   * @param options - Dispatch seam, authority, optional manifest, and optional requirements.
   */
  public constructor(private readonly options: WorkerRunnerOptions) {}

  /**
   * Execute a complete workflow by delegating to the injected dispatch seam.
   *
   * Creates an execution attempt through the Authority before dispatch. After
   * the dispatch completes (allocation acceptance), waits for the committed
   * outcome through the Authority's in-process waiter. Returns an
   * `authority-committed` completion so the host executor skips fallback
   * finalization.
   *
   * When `manifest` is supplied it takes precedence over the manifest baked into
   * the runner at construction time, enabling per-call contribution sets.
   * @param config - Full workflow worker configuration including source, inputs, and bus info.
   * @param signal - AbortSignal for cooperative cancellation forwarded to the dispatch function.
   * @param manifest - Optional per-call contribution manifest. Overrides the runner's default.
   * @param options - Optional per-run controls forwarded to dispatch-capable providers.
   * @returns Authority-committed completion after the outcome RPC converges.
   */
  public async run(
    config: WorkflowWorkerConfig,
    signal: AbortSignal,
    manifest?: WorkerContributionManifest,
    options?: WorkflowRunnerRunOptions,
  ): Promise<WorkflowRunnerCompletion> {
    // WorkerRunner owns attempt creation and waits for the Authority's
    // canonical outcome, so dispatched workers must submit rather than
    // terminalize the workflow execution themselves.
    const authorityCommittedConfig: WorkflowWorkerConfig = {
      ...config,
      terminalAuthority: 'authority',
    };

    const resolvedManifest = manifest ?? this.options.manifest;
    const resolvedRequirements = this.options.requirements;
    const dispatchMetadata = options?.dispatchMetadata;
    signal.throwIfAborted();
    const runContext =
      config.source.kind === 'path' ? await this.options.readRunContext?.(config.executionId, signal) : undefined;
    // A custom reader may finish after cancellation without observing its signal.
    signal.throwIfAborted();
    const instruction = buildWorkflowAttemptInstruction({
      id: randomUUID(),
      revision: '1',
      config,
      ...(runContext != null ? { runContext } : {}),
      preservation: { required: [] },
    });

    // The runner contract owes a completion wrapper; the generic dispatch
    // path yields the committed outcome itself.
    const result = await runAuthorityDispatchedAttempt({
      authority: this.options.authority,
      executionId: config.executionId,
      instruction,
      dispatch: (executionAttemptId) =>
        this.options.dispatch(
          {
            executionAttemptId,
            config: authorityCommittedConfig,
            ...(resolvedManifest !== undefined && { manifest: resolvedManifest }),
            ...(resolvedRequirements !== undefined && { requirements: resolvedRequirements }),
            ...(dispatchMetadata !== undefined && { metadata: dispatchMetadata }),
          },
          signal,
        ),
    });
    return { state: 'authority-committed', result: toCommittedWorkflowRunnerResult(result, config) };
  }
}
