import type {
  IWorkerNodeProvider,
  IWorkflowRunner,
  WorkerNodeCapabilities,
  WorkerNodeHandle,
  WorkerNodeProvisionRequest,
  WorkflowRunResult,
} from '@makaio/contracts';

/**
 * Convert an AbortSignal reason into the rejection value exposed by the handle.
 * @param reason - Raw abort reason from the caller signal.
 * @returns Original Error reasons, or an Error wrapping primitive reasons.
 */
function abortRejection(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(String(reason ?? 'WorkerNode wait aborted'));
}

/**
 * Construction options for {@link PiscinaWorkerNodeProvider}.
 */
export interface PiscinaWorkerNodeProviderOptions {
  /** Stable unique identifier for this provider instance. */
  readonly id: string;
  /** Human-readable label for display in UI and logs. */
  readonly displayName: string;
  /**
   * Underlying workflow runner used to execute incoming provision requests.
   *
   * Typically a {@link WorkflowPiscinaRunner} instance, but any
   * {@link IWorkflowRunner} implementation is accepted so tests can supply
   * lightweight fakes without spawning real worker threads.
   */
  readonly runner: IWorkflowRunner;
  /**
   * Capabilities advertised when this provider is registered.
   *
   * Defaults to `{ persistentStorage: true, customCapabilities: ['workflow.local-runtime'] }`
   * reflecting that the Piscina runner shares the host process file-system.
   */
  readonly baseCapabilities?: WorkerNodeCapabilities;
}

/**
 * Built-in WorkerNode provider backed by the existing workflow-level Piscina runner.
 *
 * This provider wraps an {@link IWorkflowRunner} so it can be registered with
 * the framework capability registry and participate in pool-driven dispatch.
 * Each {@link provision} call starts the underlying runner and returns a
 * {@link WorkerNodeHandle} that callers use to wait for the result or request
 * cancellation. Pool-level dispatch owns WorkerNode lifecycle events because it
 * also owns cancellation ordering and terminal state emission.
 */
export class PiscinaWorkerNodeProvider implements IWorkerNodeProvider {
  /** Execution environment tag used for pool provider matching. */
  public readonly environment = 'piscina' as const;
  /** This provider starts the runner inside {@link provision}. */
  public readonly startsExecutionDuringProvision = true;
  /** Capabilities advertised to the pool dispatch selector. */
  public readonly baseCapabilities: WorkerNodeCapabilities;

  /**
   * @param options - Provider identity, runner, and optional capability overrides.
   */
  public constructor(private readonly options: PiscinaWorkerNodeProviderOptions) {
    this.baseCapabilities = options.baseCapabilities ?? {
      persistentStorage: true,
      customCapabilities: ['workflow.local-runtime'],
    };
  }

  /** @returns Unique identifier for this provider instance. */
  public get id(): string {
    return this.options.id;
  }

  /** @returns Human-readable display name for this provider. */
  public get displayName(): string {
    return this.options.displayName;
  }

  /**
   * Provision a new isolated execution node for the given workflow request.
   *
   * Starts the underlying runner and returns a handle that the caller holds
   * until the execution reaches a terminal state. Cancellation flows through
   * the handle's `cancel` / `terminate` methods, which abort the internal
   * `AbortController` wired to the runner's signal.
   * @param request - Full provision request containing worker config and manifest.
   * @returns A handle for the provisioned node with wait, cancel, and terminate operations.
   */
  public async provision(request: WorkerNodeProvisionRequest): Promise<WorkerNodeHandle> {
    const controller = new AbortController();
    const resultPromise = this.options.runner.run(request.workerConfig, controller.signal, request.workerManifest);
    // Absorb rejections that arrive before any caller awaits waitForResult,
    // preventing unhandled-rejection crashes if cancel/terminate is called
    // before the result is observed.
    resultPromise.catch(() => undefined);

    return {
      nodeId: request.nodeId,
      /**
       * Wait for the execution to reach a terminal state.
       *
       * Forwards abort from the caller's signal to the internal controller and
       * rejects immediately. The abort listener is removed when the promise
       * settles to avoid lingering listeners on long-lived external signals.
       * @param signal - AbortSignal that aborts the underlying runner when triggered.
       * @returns The final execution result.
       */
      waitForResult: async (signal: AbortSignal): Promise<WorkflowRunResult> => {
        if (signal.aborted) {
          controller.abort(signal.reason);
          return Promise.reject(abortRejection(signal.reason));
        }

        let rejectAbort!: (reason?: unknown) => void;
        const abortPromise = new Promise<never>((_, reject) => {
          rejectAbort = reject;
        });
        const onAbort = (): void => {
          controller.abort(signal.reason);
          rejectAbort(abortRejection(signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          return await Promise.race([resultPromise, abortPromise]);
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      },
      /**
       * Request graceful cancellation of the running execution.
       *
       * Resolves after cancellation is dispatched; callers that need terminal
       * completion should await {@link waitForResult}.
       * @param reason - Optional human-readable cancellation reason.
       * @returns Promise that resolves when cancellation has been dispatched.
       */
      cancel: (reason?: string): Promise<void> => {
        controller.abort(reason ?? 'WorkerNode cancelled');
        return Promise.resolve();
      },
      /**
       * Forcibly terminate the execution environment.
       *
       * Resolves after termination is dispatched; callers that need terminal
       * completion should await {@link waitForResult}.
       * @returns Promise that resolves when termination has been dispatched.
       */
      terminate: (): Promise<void> => {
        controller.abort('WorkerNode terminated');
        return Promise.resolve();
      },
    };
  }
}
