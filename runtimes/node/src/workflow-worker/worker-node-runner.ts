import type {
  IWorkflowRunner,
  WorkerContributionManifest,
  WorkerNodeDispatch,
  WorkerNodeRequirements,
  WorkflowRunResult,
  WorkflowWorkerConfig,
} from '@makaio/contracts';

/**
 * Construction options for {@link WorkerNodeRunner}.
 */
export interface WorkerNodeRunnerOptions {
  /**
   * Dispatch seam injected by the host composition root.
   *
   * Product hosts wire this to `workerPool.dispatch` or another implementation.
   * Framework code calls through this seam without coupling to any pool.
   */
  readonly dispatch: WorkerNodeDispatch;
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
  readonly requirements?: WorkerNodeRequirements;
}

/**
 * Workflow runner that delegates full workflow execution to a WorkerNode
 * dispatch seam supplied by the host composition root.
 *
 * This class implements the {@link IWorkflowRunner} contract while remaining
 * product-agnostic. Concrete dispatch behavior (e.g. pool selection, provider
 * matching, manifest resolution) lives in the product-owned composition root
 * or `workerPool.dispatch` handler, not here.
 */
export class WorkerNodeRunner implements IWorkflowRunner {
  /**
   * @param options - Dispatch seam, optional manifest, and optional requirements.
   */
  public constructor(private readonly options: WorkerNodeRunnerOptions) {}

  /**
   * Execute a complete workflow by delegating to the injected dispatch seam.
   *
   * When `manifest` is supplied it takes precedence over the manifest baked into
   * the runner at construction time, enabling per-call contribution sets.
   * @param config - Full workflow worker configuration including source, inputs, and bus info.
   * @param signal - AbortSignal for cooperative cancellation forwarded to the dispatch function.
   * @param manifest - Optional per-call contribution manifest. Overrides the runner's default.
   * @returns The execution result with terminal status and optional output.
   */
  public run(
    config: WorkflowWorkerConfig,
    signal: AbortSignal,
    manifest?: WorkerContributionManifest,
  ): Promise<WorkflowRunResult> {
    const resolvedManifest = manifest ?? this.options.manifest;

    return this.options.dispatch(
      {
        config,
        ...(resolvedManifest !== undefined && { manifest: resolvedManifest }),
        ...(this.options.requirements !== undefined && { requirements: this.options.requirements }),
      },
      signal,
    );
  }
}
