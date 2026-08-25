import { randomUUID } from 'node:crypto';
import Piscina from 'piscina';
import {
  CODE_EXECUTION_IDENTIFIER_MAX_LENGTH,
  JsonValueSchema,
  codeExecutionAbortOutcome,
  type CodeExecutionFailedOutcome,
  type CodeExecutionOutcome,
  type CodeExecutionProviderContext,
  type CodeExecutionRequest,
  type CodeExecutionTrustLevel,
  type ICodeExecutionProvider,
} from '@makaio/contracts';
import {
  CODE_EXECUTION_DEFAULT_IDLE_TIMEOUT_MS,
  CODE_EXECUTION_DEFAULT_MAX_ARGUMENT_BYTES,
  CODE_EXECUTION_DEFAULT_MAX_CONCURRENCY,
  CODE_EXECUTION_DEFAULT_MAX_INVOCATIONS_PER_WORKER,
  CODE_EXECUTION_DEFAULT_MAX_PROGRAM_FILES,
  CODE_EXECUTION_DEFAULT_MAX_QUEUED_INVOCATIONS,
  CODE_EXECUTION_DEFAULT_MAX_RESULT_BYTES,
  CODE_EXECUTION_DEFAULT_MAX_SOURCE_BYTES,
  CodeExecutionWorkerOutcomeSchema,
  describeThrownValue,
  failedOutcome,
  measureSerializedBytes,
  sanitizeDiagnosticMessage,
  type CodeExecutionWorkerTask,
  type PiscinaCodeExecutionProviderOptions,
} from './types.js';
import { resolveConfiguredRuntime } from './configured-redactions.js';
import { InvocationAdmissionGate, type AdmissionRelease } from './invocation-admission-gate.js';
import { snapshotInvocationInput } from './invocation-input.js';
import { isAbortError, isPoolTeardownError, type PoolDispatchResult } from './pool-dispatch.js';
import {
  type AdmittedInvocationInput,
  type PoolSubmission,
  type RuntimeConfiguration,
  type WorkerGeneration,
} from './provider-internals.js';
import { requireFiniteOption, requireIntegerOption, requireNamedOption } from './provider-options.js';
import { requestAdmissionFailure } from './request-admission.js';
import { RetainedProgramRoots } from './retained-program-roots.js';
import {
  assertProgramWithinBudget,
  materializeVirtualProgram,
  UnreleasedProgramRootError,
  normalizePackageRoots,
  VirtualProgramError,
  type MaterializedVirtualProgram,
  type ProgramRootLease,
} from './virtual-program-materializer.js';
import { resolveDefaultCodeExecutionWorkerEntry } from './worker-entry-resolver.js';

// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// Opt-in CodeExecution provider that runs prepared TypeScript/ESM programs on
// a Piscina worker-thread pool.
//
// Each invocation materializes its own temporary program root, hands the
// worker only resolved URLs and JSON values, and removes that root again on
// every terminal path. TypeScript is transpiled on import inside the worker,
// so nothing is bundled ahead of time, no repository dependency is installed,
// and no submitted module is ever loaded in the host thread.
//
// The provider declares `trusted-code-only` and means it. A worker thread
// keeps a runaway program off the host event loop and lets an aborted
// execution be torn down, the environment and package map default to the
// smallest useful surface, and a resolve guard in the worker holds the package
// map to being the whole truth about which ordinary packages resolve — but
// Node built-ins, absolute imports, dynamic loading, and direct filesystem
// access all remain available to executed code. Only submit code the host
// already trusts.

/** Default identifier of the built-in Piscina CodeExecution provider. */
const DEFAULT_PROVIDER_ID = 'piscina-code-execution';

/** Default human-readable name of the built-in Piscina CodeExecution provider. */
const DEFAULT_DISPLAY_NAME = 'Local (Piscina)';

/** Prefix of the per-invocation TypeScript loader namespace. */
const NAMESPACE_PREFIX = 'makaio-code-execution';

/** Summary reported for every execution attempted after disposal. */
const DISPOSED_MESSAGE = 'This CodeExecution provider has been disposed.';

/**
 * Build the outcome reported for every execution the disposal barrier rejects.
 * @returns Failed outcome coded `provider_unavailable`.
 */
function disposedOutcome(): CodeExecutionFailedOutcome {
  return failedOutcome('provider_unavailable', DISPOSED_MESSAGE);
}

/**
 * Resolve cleanup work transferred by a failed materialization, when any.
 * @param error - Materialization failure being classified for the invocation outcome.
 * @returns Cleanup lease transferred by the error, when it carries one.
 */
function rootLeaseFromMaterializationFailure(error: unknown): ProgramRootLease | undefined {
  return error instanceof UnreleasedProgramRootError ? error.rootLease : undefined;
}

/**
 * Build the outcome reported for an invocation that arrived at a full queue.
 *
 * Coded `provider_unavailable` for the same reason a disposed provider is: the
 * code covers a provider that is not accepting work, and a provider whose slots
 * and queue are both full is not. The alternatives would each say something
 * untrue — `provider_failed` blames a provider that is working exactly as
 * configured, and `invalid_program` blames a request that was perfectly
 * submittable and would have run a moment earlier or later.
 *
 * The message names only configured figures, so it stays free of anything the
 * caller submitted and of anything the host configured secretly.
 * @param maxConcurrency - Configured concurrent execution limit.
 * @param maxQueued - Configured waiting-queue limit.
 * @returns Failed outcome coded `provider_unavailable`.
 */
function atCapacityOutcome(maxConcurrency: number, maxQueued: number): CodeExecutionFailedOutcome {
  return failedOutcome(
    'provider_unavailable',
    `This CodeExecution provider is at capacity: ${maxConcurrency} invocations are executing and ${maxQueued} are waiting.`,
  );
}

/**
 * CodeExecution provider that executes prepared TypeScript/ESM programs on a
 * Piscina worker-thread pool.
 *
 * Register it explicitly through `registerCodeExecutionProvider` — the
 * composing host decides whether a runtime is allowed to execute submitted
 * code at all, and owns unregistering the provider before disposing it.
 *
 * The declared tags are what a program is admitted against, and the module set
 * is held to them: `.ts`, `.mts`, `.js`, and `.mjs` sources are executed, and a
 * program carrying anything else is refused as `invalid_program` rather than run
 * under semantics — CommonJS, JSX — this provider never advertised.
 *
 * Anything the executed program writes to `stdout` or `stderr` is forwarded to
 * the host process's own streams. That is deliberate: local process logs are
 * ordinary diagnostics for a `trusted-code-only` provider, and the contract's
 * leak invariant governs what crosses the bus — the terminal outcome — not what
 * the host prints to its own console.
 */
export class PiscinaCodeExecutionProvider implements ICodeExecutionProvider {
  /** Unique identifier for this provider instance. */
  public readonly id: string;
  /** Human-readable name for display in a host UI. */
  public readonly displayName: string;
  /** Selection priority among matching providers; higher wins. */
  public readonly priority: number;
  /** Runtime tag this provider executes on. */
  public readonly runtime = 'node';
  /** Source language this provider accepts. */
  public readonly language = 'typescript';
  /** Module format the materialized program root is treated as. */
  public readonly moduleFormat = 'esm';
  /** Trust level: this provider runs code with worker-thread privileges. */
  public readonly trust: CodeExecutionTrustLevel = 'trusted-code-only';

  private readonly workerEntry: string;
  private readonly workerExecArgv: readonly string[];
  /**
   * Environment the resolved worker entry's own loader requires.
   *
   * Kept apart from the host-configured {@link environment} because the two
   * answer to different owners: this one configures the loader named by
   * {@link workerExecArgv}, so it travels with those arguments and is applied
   * *after* the host's values — a host must not be able to reconfigure the
   * loader that bounds which packages a submitted program can resolve.
   */
  private readonly workerLoaderEnv: Readonly<Record<string, string>>;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly packageRoots: ReadonlyMap<string, string>;
  private readonly maxConcurrency: number;
  private readonly maxQueuedInvocations: number;
  private readonly idleTimeoutMs: number;
  private readonly maxProgramFiles: number;
  private readonly maxSourceBytes: number;
  private readonly maxResultBytes: number;
  private readonly maxArgumentBytes: number;
  private readonly maxInvocationsPerWorker: number;
  private readonly admission: InvocationAdmissionGate;
  private readonly inFlight = new Set<Promise<CodeExecutionOutcome>>();
  /**
   * Resource releases that outlive the outcomes they belong to.
   *
   * An invocation reports its outcome as soon as it has one and releases its
   * program root and admission slot afterwards, so the disposal barrier cannot
   * be satisfied by {@link inFlight} alone: the last outcome can be settled
   * while a temporary root still exists. Each release is tracked here until it
   * completes, which is what keeps "after `dispose()` resolves, nothing of this
   * provider's remains" a property of the barrier rather than of timing.
   */
  private readonly quiescing = new Set<Promise<void>>();
  /**
   * Generations that were retired while still carrying invocations.
   *
   * A retired generation takes no new work but is not gone yet, so it stays
   * reachable here until it has answered what it holds and torn itself down.
   * The disposal barrier needs it for exactly that reason: awaiting only the
   * current generation would let worker threads outlive a `dispose()` that
   * promised the provider was quiesced.
   */
  private readonly draining = new Set<WorkerGeneration>();
  /**
   * Program roots whose removal failed and is therefore still owed.
   *
   * Retried opportunistically as later invocations quiesce, and mandatorily at
   * {@link dispose} — after every worker is down, which is precisely when the
   * open file that blocked the earlier attempts no longer exists.
   */
  private readonly retained = new RetainedProgramRoots();

  private runtimeConfiguration: Promise<RuntimeConfiguration> | undefined;
  private generation: WorkerGeneration | undefined;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  /**
   * @param options - Host composition options; every field has a documented
   *   default and the package map defaults to no ordinary packages at all.
   * @throws {@link Error} When the configured package map contains a name that
   * is not an ordinary bare specifier or a root that is not absolute, when a
   * numeric option is not a usable number, or when an option that names
   * something is empty. All are composition errors, so they surface where the
   * provider is assembled instead of as an execution outcome.
   */
  public constructor(options: PiscinaCodeExecutionProviderOptions = {}) {
    const defaultEntry = resolveDefaultCodeExecutionWorkerEntry(import.meta.url);
    this.id = requireNamedOption('id', options.id ?? DEFAULT_PROVIDER_ID, CODE_EXECUTION_IDENTIFIER_MAX_LENGTH);
    this.displayName = requireNamedOption('displayName', options.displayName ?? DEFAULT_DISPLAY_NAME);
    this.priority = requireFiniteOption('priority', options.priority ?? 0);
    this.workerEntry = defaultEntry.filename;
    // Both lazily consumed option containers are snapshotted here rather than
    // retained: the pool is built at the first execution, so a caller mutating
    // the options object in between would otherwise decide what the worker
    // threads are launched with long after composition. For the environment
    // that is also a leak: runtime redactions are derived from this snapshot,
    // so a value substituted afterwards would reach the worker unredacted.
    this.workerExecArgv = [...defaultEntry.execArgv];
    this.workerLoaderEnv = Object.freeze({ ...defaultEntry.env });
    this.environment = Object.freeze({ ...options.environment });
    this.packageRoots = normalizePackageRoots(options.packageRoots);
    this.maxConcurrency = requireIntegerOption(
      'maxConcurrency',
      options.maxConcurrency ?? CODE_EXECUTION_DEFAULT_MAX_CONCURRENCY,
      1,
    );
    // Zero is admissible, and means it: a host that would rather refuse than
    // queue configures no queue at all.
    this.maxQueuedInvocations = requireIntegerOption(
      'maxQueuedInvocations',
      options.maxQueuedInvocations ?? CODE_EXECUTION_DEFAULT_MAX_QUEUED_INVOCATIONS,
      0,
    );
    this.idleTimeoutMs = requireIntegerOption(
      'idleTimeoutMs',
      options.idleTimeoutMs ?? CODE_EXECUTION_DEFAULT_IDLE_TIMEOUT_MS,
      0,
    );
    this.maxInvocationsPerWorker = requireIntegerOption(
      'maxInvocationsPerWorker',
      options.maxInvocationsPerWorker ?? CODE_EXECUTION_DEFAULT_MAX_INVOCATIONS_PER_WORKER,
      1,
    );
    this.maxProgramFiles = requireIntegerOption(
      'maxProgramFiles',
      options.maxProgramFiles ?? CODE_EXECUTION_DEFAULT_MAX_PROGRAM_FILES,
      1,
    );
    this.maxSourceBytes = requireIntegerOption(
      'maxSourceBytes',
      options.maxSourceBytes ?? CODE_EXECUTION_DEFAULT_MAX_SOURCE_BYTES,
      1,
    );
    this.maxResultBytes = requireIntegerOption(
      'maxResultBytes',
      options.maxResultBytes ?? CODE_EXECUTION_DEFAULT_MAX_RESULT_BYTES,
      1,
    );
    this.maxArgumentBytes = requireIntegerOption(
      'maxArgumentBytes',
      options.maxArgumentBytes ?? CODE_EXECUTION_DEFAULT_MAX_ARGUMENT_BYTES,
      1,
    );
    this.admission = new InvocationAdmissionGate(this.maxConcurrency, this.maxQueuedInvocations);
  }

  /**
   * Execute one prepared invocation to a terminal outcome.
   *
   * The invocation is tracked while it runs so {@link dispose} can wait for it,
   * and it is removed again on every terminal path. The outcome is reported as
   * soon as the invocation has one; the resources it held are released
   * afterwards, under the separate tracking {@link dispose} also waits for.
   * @param request - Prepared, JSON-safe invocation to execute.
   * @param context - Effective cancellation signal and deadline for the execution.
   * @returns Exactly one normalized terminal outcome for the invocation.
   */
  public async execute(
    request: CodeExecutionRequest,
    context: CodeExecutionProviderContext,
  ): Promise<CodeExecutionOutcome> {
    if (this.disposed) return disposedOutcome();

    const invocation = this.runInvocation(request, context);
    this.inFlight.add(invocation);
    try {
      return await invocation;
    } finally {
      this.inFlight.delete(invocation);
    }
  }

  /**
   * Destroy the worker pool, reject further executions, and drain what is running.
   *
   * This is a barrier, not a request: once it *resolves* the pool is destroyed,
   * every invocation that was still materializing or dispatching has reached a
   * terminal outcome, and every temporary program root and admission slot those
   * invocations held has been released. Concurrent and repeated calls all await
   * the same disposal, so the barrier holds for every caller. The composing
   * host is responsible for unregistering the provider before disposing it, so
   * no execution is routed here afterwards.
   *
   * A pool that refuses to shut down is therefore a rejection, not a warning:
   * worker threads may still be alive, so resolving would assert exactly the
   * thing that failed. The rest of the barrier still runs first — the
   * invocations are drained, the releases are awaited, and the retained roots
   * get their final round — so one pool's failure never costs the cleanup that
   * had nothing to do with it, and the rejection carries every teardown failure
   * rather than the first. Repeated calls await the same memoized disposal and
   * therefore reject again, with the same reasons: idempotent means the same
   * outcome, not a second attempt that reports success.
   *
   * Removal of the temporary program roots is retried rather than abandoned.
   * Each invocation removes its own root with bounded retries — short, because
   * a cleanup failure must never delay the execution outcome — and a root that
   * outlives them is kept as pending work instead of merely logged. This
   * barrier makes the final attempt on whatever is still pending, and it makes
   * it in the one position where it is most likely to succeed: every worker
   * thread is already down, so the open file that blocked the earlier attempts
   * is gone. Only a root that survives even that is reported to local
   * diagnostics, naming the directory left behind — and only reported, because
   * what is left is inert data on disk rather than something of this provider's
   * still running, which is the distinction that decides warn against reject.
   * @returns Promise that resolves once the provider is fully quiesced.
   * @throws {@link AggregateError} When one or more worker pools could not be
   * torn down, after the rest of the barrier has completed.
   */
  public dispose(): Promise<void> {
    // Set synchronously so an execution that has not yet been admitted sees the
    // disposal before it can materialize anything.
    this.disposed = true;
    this.disposal ??= this.destroyPoolAndDrain();
    return this.disposal;
  }

  /**
   * Destroy the pool and wait for every tracked invocation to settle.
   *
   * Invocations still queued for admission are already tracked, and disposal
   * releases their predecessors' slots, so they are admitted, observe the
   * disposal, and settle rather than blocking the barrier.
   *
   * Draining generations are torn down here alongside the current one, and
   * without waiting for them to drain first: they are still running the
   * invocations they hold, and an invocation that only ends by termination
   * would otherwise make the barrier depend on the submitted program. Teardown
   * is memoized per generation, so one that had already begun shutting itself
   * down is awaited rather than shut down a second time.
   *
   * The two waits below are ordered, not concurrent, and the order is the
   * contract: an invocation registers its resource release as it settles, so
   * the set of outstanding releases is only complete once every invocation has
   * settled. Snapshotting it earlier would let a root materialized by the last
   * invocation outlive the barrier.
   *
   * The retained-root sweep is last for the same reason and one more: every
   * invocation has settled and every release has run, so the retained set is
   * complete, and every worker thread is down, so a handle that blocked an
   * earlier removal has been released. It is the last attempt anyone makes, and
   * the best-placed one.
   *
   * A teardown failure is retained rather than reported where it happens, and
   * raised only once all of the above has run. Failing early would skip the
   * drain and the sweep, which is the opposite of what a pool that would not
   * shut down calls for; failing not at all would resolve a barrier whose
   * central promise — that nothing of this provider's is still running — is the
   * one that just broke.
   * @returns Promise that resolves once no pool remains, nothing is in flight,
   * and every invocation's resources have been released.
   * @throws {@link AggregateError} Carrying every pool that could not be torn
   * down, raised after the drain, the releases, and the retained-root sweep.
   */
  private async destroyPoolAndDrain(): Promise<void> {
    const generations = [...(this.generation === undefined ? [] : [this.generation]), ...this.draining];
    this.generation = undefined;
    const teardowns = await Promise.allSettled(generations.map((generation) => this.tearDown(generation)));
    await Promise.allSettled([...this.inFlight]);
    await Promise.allSettled([...this.quiescing]);
    const residual = await this.retained.retryAll();
    if (residual.length > 0) {
      console.warn('[code-execution] Program roots still on disk after disposal: %s', residual.join(', '));
    }
    const failures = teardowns.filter((teardown) => teardown.status === 'rejected').map((teardown) => teardown.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'The CodeExecution provider could not tear down every worker pool.');
    }
  }

  /**
   * Run one invocation from admission to its terminal outcome.
   *
   * Admission bounds how many invocations hold a temporary program root at
   * once, and how many wait for one. An invocation that arrives once both are
   * full is refused there and then rather than queued, because a queue position
   * it can only leave by timing out buys it nothing and costs the host its
   * retained request for the whole wait. Disposal and cancellation are both
   * re-checked after admission and after materialization, so neither an
   * execution that started before `dispose()` nor one whose signal settled
   * meanwhile can revive the pool.
   *
   * Every terminal path — success, failure, timeout, and cancellation alike —
   * hands the materialized root and the admission slot to {@link trackRelease},
   * which releases them *after* this returns. The outcome is what the caller
   * waited for and the release is not; see the `finally` below for why the two
   * are separated.
   *
   * The request's own rules are checked *before* admission — the program's in
   * {@link assertProgramWithinBudget}, the rest in {@link requestAdmissionFailure}.
   * All of them are pure and decide the outcome on their own, so making an
   * inadmissible request wait for a slot would only park it, and a burst of them
   * would hold their oversized sources, export names, and untransportable
   * arguments in memory behind a full gate — long enough for the deadline to
   * report `timed_out` for a request that was never admissible in the first
   * place. Rejecting up front keeps `invalid_program` the answer regardless of
   * how loaded the provider is.
   *
   * Host configuration is resolved only after admission, so slow filesystem
   * resolution remains covered by the provider's queue bound. Every exit after
   * that point sanitizes diagnostics against the same pinned configuration.
   * @param request - Prepared, JSON-safe invocation to execute.
   * @param context - Effective cancellation signal and deadline for the execution.
   * @returns Exactly one normalized terminal outcome for the invocation.
   */
  private async runInvocation(
    request: CodeExecutionRequest,
    context: CodeExecutionProviderContext,
  ): Promise<CodeExecutionOutcome> {
    const owned = snapshotInvocationInput(request);
    if ('status' in owned) return owned;
    let configuration: RuntimeConfiguration | undefined;
    let materialized: MaterializedVirtualProgram | undefined;
    let programRoot: ProgramRootLease | undefined;
    let release: AdmissionRelease | undefined;
    let teardown: Promise<void> | undefined;
    try {
      assertProgramWithinBudget(owned.program, this.maxProgramFiles, this.maxSourceBytes);
      const inadmissible = requestAdmissionFailure(owned, this.maxArgumentBytes);
      if (inadmissible !== undefined) return inadmissible;
      const argumentsValue = JsonValueSchema.safeParse(owned.arguments);
      if (!argumentsValue.success) {
        return failedOutcome('invalid_program', 'The invocation arguments do not satisfy the CodeExecution contract.');
      }
      // `argumentsValue.data` is the parsed owned snapshot. It — never the
      // caller's live `request.arguments` — is retained across admission and
      // dispatched to the worker.
      const admitted = { program: owned.program, arguments: argumentsValue.data };

      const admission = await this.admission.acquire(context.signal);
      if (!admission.admitted) {
        return admission.refusal === 'aborted'
          ? codeExecutionAbortOutcome(context)
          : atCapacityOutcome(this.maxConcurrency, this.maxQueuedInvocations);
      }
      release = admission.release;
      if (this.disposed) return disposedOutcome();
      // The gate resolves a queued invocation by handing it a released slot, so
      // the signal can settle between that hand-off and this frame. Observing
      // it here keeps an already-dead invocation from paying for a temporary
      // program root it will never use.
      if (context.signal.aborted) return codeExecutionAbortOutcome(context);

      configuration = await this.resolveRuntimeConfiguration();
      if (this.disposed) return disposedOutcome();
      if (context.signal.aborted) return codeExecutionAbortOutcome(context);

      materialized = await materializeVirtualProgram({
        program: admitted.program,
        packageRoots: configuration.packageRoots,
        maxProgramFiles: this.maxProgramFiles,
        maxSourceBytes: this.maxSourceBytes,
      });
      programRoot = materialized;
      // INVARIANT: nothing between this check and the pool creation inside
      // `dispatch` may await. `destroyPoolAndDrain` clears the current
      // generation, so `acquireGeneration` would build a fresh one for a
      // disposed provider — and only the absence of a suspension point here
      // rules out a `dispose()` interleaving between the two. Introducing an
      // `await` below reopens it.
      if (this.disposed) return disposedOutcome();
      // Cancellation gets the same barrier as disposal, for the same reason:
      // `dispatch` creates the pool lazily, so an invocation aborted while it
      // was materializing would otherwise spawn worker threads for a run that
      // is already over. Synchronous, so the no-await invariant above holds.
      if (context.signal.aborted) return codeExecutionAbortOutcome(context);

      const task = this.createTask(admitted, materialized, configuration);
      const dispatched = await this.dispatch(task, context.signal);
      teardown = dispatched.teardown;
      if (dispatched.kind === 'aborted') return codeExecutionAbortOutcome(context);
      if (dispatched.kind === 'failed') return this.toFailureOutcome(dispatched.error, task.redactedPaths);
      return this.toOutcome(dispatched.value, task.redactedPaths);
    } catch (error) {
      // A failed materialization can transfer an unremoved root into the same
      // release path that retains and retries dispatched-program roots.
      programRoot = rootLeaseFromMaterializationFailure(error) ?? programRoot;
      return this.toFailureOutcome(error, [
        ...(materialized?.redactedPaths ?? []),
        ...(configuration?.redactions ?? []),
      ]);
    } finally {
      // Deliberately not awaited. The outcome is decided by the time this runs,
      // and the caller's deadline is still live: a caller racing this promise
      // against a deadline — which is what the routing service does — would
      // otherwise discard a finished outcome and report `timed_out` because a
      // filesystem removal was slow. An outcome must not depend on the latency
      // of releasing what produced it.
      this.trackRelease(programRoot, release, teardown);
    }
  }

  /**
   * Release one invocation's resources, and never fail doing so.
   *
   * Cleanup precedes the slot release, which is what keeps the admission bound
   * a bound on *resources* rather than on dispatch: the next admitted
   * invocation cannot start before this one's temporary root is gone, so the
   * number of roots in existence stays at or below the configured concurrency.
   * That ordering is the reason the slot is not released as soon as the outcome
   * is reported, even though the caller no longer waits for either.
   *
   * A root the bounded retries could not remove becomes {@link retained} work
   * rather than a warning nobody acts on, and it is the one thing the bound
   * above does not cover: a retained root outlives the slot that produced it, so
   * while any exist the roots on disk are the admitted ones *plus* the retained
   * ones. Making the release wait for it instead would not restore the bound —
   * it would stall admission on a handle the provider does not hold — so the
   * bound is stated honestly here and the excess is discharged by retrying. The
   * slot is therefore freed regardless, and *before* anything retained is
   * retried, or a queued invocation would wait on somebody else's stuck handle.
   *
   * The retry that follows deliberately covers only what was already retained
   * when this invocation began releasing — the roots of *earlier* invocations,
   * whose workers have had a whole invocation's worth of time to exit. This
   * invocation's own root is excluded: its bounded attempts have only just run
   * out, so repeating them in the same tick would spend the same delay on the
   * same answer. {@link dispose} owns the mandatory retry that covers everything.
   * @param programRoot - Program root cleanup lease, when one was created.
   * @param release - Admission slot handle, when the invocation was admitted.
   * @param teardown - Teardown triggered by the generation this invocation used.
   * @returns Promise that resolves once the root is gone or retained, the slot
   * is free, and the previously retained roots have been retried once.
   */
  private async quiesce(
    programRoot: ProgramRootLease | undefined,
    release: AdmissionRelease | undefined,
    teardown: Promise<void> | undefined,
  ): Promise<void> {
    const earlier = this.retained.pending;
    if (programRoot !== undefined) await this.retained.release(programRoot);
    // A retired generation that has started shutting down cannot be allowed to
    // overlap indefinitely with successor pools. The caller already has its
    // terminal outcome; only admission waits for the teardown it triggered.
    if (teardown !== undefined) await Promise.allSettled([teardown]);
    release?.();
    await this.retained.retry(earlier);
  }

  /**
   * Start one invocation's resource release and keep it reachable until it ends.
   *
   * Synchronous, and it has to be: it runs in the `finally` of the invocation
   * whose outcome is about to be reported, so the release is registered before
   * that outcome can be observed. The disposal barrier depends on exactly that
   * ordering — it collects outstanding releases only after every invocation has
   * settled, and would otherwise miss the last one.
   *
   * The tracking chain absorbs a rejection before untracking. {@link quiesce}
   * does not throw — every step it takes contains its own failures — but the
   * chain adopts whatever the release settles as, so a future step that did
   * throw would surface as an unhandled rejection instead of as the local
   * diagnostic it warrants. The disposal barrier is unaffected either way: it
   * awaits the tracked promise through `allSettled`.
   * @param programRoot - Program root cleanup lease, when one was created.
   * @param release - Admission slot handle, when the invocation was admitted.
   * @param teardown - Teardown triggered by the generation this invocation used.
   */
  private trackRelease(
    programRoot: ProgramRootLease | undefined,
    release: AdmissionRelease | undefined,
    teardown: Promise<void> | undefined,
  ): void {
    const quiesced = this.quiesce(programRoot, release, teardown);
    this.quiescing.add(quiesced);
    void quiesced
      .catch((error: unknown) => {
        console.warn('[code-execution] Failed to release an invocation: %s', error);
      })
      .finally(() => this.quiescing.delete(quiesced));
  }

  /**
   * Dispatch one task to the worker pool and separate aborts from failures.
   *
   * Only a rejection produced by the abort itself is reported as aborted. A
   * worker failure that merely happens to be observed once the signal has
   * already fired keeps its own classification.
   * @param task - Structured-clone-safe task for this invocation.
   * @param signal - Effective cancellation signal for the execution.
   * @returns The raw worker value, or the fact that the run was aborted.
   */
  private async dispatch(task: CodeExecutionWorkerTask, signal: AbortSignal): Promise<PoolDispatchResult> {
    const submission = this.submit(task, signal);
    try {
      return { kind: 'completed', value: await submission.running, teardown: submission.generation.teardown };
    } catch (error) {
      const teardown = submission.generation.teardown;
      if (signal.aborted && isAbortError(error)) return { kind: 'aborted', teardown };
      return { kind: 'failed', error, teardown };
    }
  }

  /**
   * Hand one task to the current worker generation and account for it.
   *
   * Submission strictly precedes retirement, and that order is the contract: a
   * retired generation takes nothing further, so counting this invocation and
   * retiring in the same breath would strand the very task the count was for.
   * Nothing between the two awaits, so no other invocation can interleave and
   * submit onto a generation that is already leaving.
   * @param task - Structured-clone-safe task for this invocation.
   * @param signal - Effective cancellation signal for the execution.
   * @returns The raw value the worker thread produced.
   */
  private submit(task: CodeExecutionWorkerTask, signal: AbortSignal): PoolSubmission<WorkerGeneration> {
    const generation = this.acquireGeneration();
    generation.submitted += 1;
    generation.outstanding += 1;
    const running = generation.pool.run(task, { signal });
    if (generation.submitted >= this.maxInvocationsPerWorker) this.retire(generation);
    // Every settlement decrements, including an abort and a pool fault, because
    // what is being counted is whether the generation still owes an answer —
    // not whether the answer was a good one.
    return {
      generation,
      running: running.finally(() => {
        generation.outstanding -= 1;
        this.tearDownIfDrained(generation);
      }),
    };
  }

  /**
   * Detach a worker generation that has served its share of invocations.
   *
   * Retirement is what bounds a worker's memory. Every invocation imports a
   * freshly materialized program under a URL Node has never seen, so its module
   * graph enters the worker's module map and is never evicted; idle reaping
   * does not reach a pool that is never idle. Replacing the threads is the only
   * way to release those graphs.
   *
   * Detaching is immediate and unconditional, which is what makes the bound
   * hold under sustained load: the generation's outstanding count can only fall
   * from here, so it reaches zero and is torn down no matter how busy the
   * provider stays. Waiting for a quiet moment instead would never find one.
   *
   * Retiring a whole generation rather than one thread at a time keeps this a
   * rule about a resource the provider owns outright, instead of bookkeeping
   * about which pool thread has served how much. It retires sooner than
   * strictly necessary above a concurrency of one, and that direction is the
   * safe one: the configured figure stays an upper bound per thread.
   *
   * A generation retired while it still carries an invocation overlaps with its
   * successor, so the *threads* in existence can briefly exceed
   * `maxConcurrency`. That is accepted here rather than fixed, and the bound is
   * worth stating precisely because the headline number is a promise about
   * something else:
   *
   * - Threads actually **running** submitted code never exceed `maxConcurrency`.
   *   The admission gate bounds invocations between admission and release, and
   *   an invocation occupies one thread of one generation. The excess is idle
   *   threads a retired generation had already spawned.
   * - A completed invocation that triggered teardown keeps its admission slot
   *   until that teardown settles. Slow teardown therefore consumes capacity
   *   instead of allowing an unbounded chain of successor pools.
   * - `minThreads: 0` with the configured `idleTimeout` reaps idle threads in
   *   a draining pool while its already-submitted work finishes.
   *
   * Shrinking a retired pool proactively would be the better answer, and Piscina
   * 5.2 offers no seam for it: `maxThreads`, `minThreads`, and `idleTimeout` are
   * read-only accessors, and `close()` cannot stand in — its flush waits only
   * for tasks a worker has already *started* and then destroys the pool, which
   * would cut short an invocation still queued for a free thread. Reaching into
   * the pool's internal options object instead would make this provider's
   * correctness depend on an undocumented field surviving a dependency upgrade.
   * @param generation - Generation to detach from further work.
   */
  private retire(generation: WorkerGeneration): void {
    if (this.generation === generation) this.generation = undefined;
    generation.retired = true;
    this.draining.add(generation);
    this.tearDownIfDrained(generation);
  }

  /**
   * Retire a pool immediately when Piscina reports a bootstrap or worker error.
   *
   * Piscina is an EventEmitter: without this listener an error emitted before a
   * task promise settles is an unhandled host exception. A failed generation is
   * never reused; destroying it also settles any queued runs so they report a
   * terminal provider failure and the next invocation can create a fresh pool.
   * @param generation - Pool generation that emitted the error.
   * @param error - Piscina bootstrap or worker error.
   */
  private handlePoolError(generation: WorkerGeneration, error: Error): void {
    if (generation.failed) return;
    generation.failed = true;
    this.retire(generation);
    void this.tearDown(generation).catch((teardownError: unknown) => {
      console.warn('[code-execution] Failed to tear down a failed worker generation: %s', teardownError);
    });
    console.warn('[code-execution] Worker generation failed: %s', error);
  }

  /**
   * Tear a retired generation down once it owes no further answers.
   *
   * The pool is destroyed rather than closed, and only ever with nothing
   * outstanding, so the two are the same thing here: there is no task left to
   * cut short, only idle threads to release. Closing would be the weaker
   * choice — a pool's own flush waits for the tasks its workers have *started*,
   * which says nothing about one still waiting for a worker to become ready.
   *
   * A generation is forgotten only once its teardown succeeded. One that failed
   * stays in {@link draining} on purpose: its threads may still be alive, so it
   * is still this provider's to answer for, and leaving it reachable is what
   * lets a later {@link dispose} collect the failure rather than resolve as
   * though the generation had gone quietly. Nobody awaits this path, so the
   * failure is reported locally as well — that log is the only account of it for
   * a provider that is never disposed.
   * @param generation - Generation whose remaining work may have finished.
   */
  private tearDownIfDrained(generation: WorkerGeneration): void {
    if (!generation.retired || generation.outstanding > 0) return;
    void this.tearDown(generation)
      .then(() => this.draining.delete(generation))
      .catch((error: unknown) => {
        console.warn('[code-execution] Failed to tear down a drained worker generation: %s', error);
      });
  }

  /**
   * Destroy one generation's pool, at most once.
   *
   * Memoized on the generation because two paths reach it: the generation
   * draining on its own, and the disposal barrier tearing everything down. The
   * second must await the shutdown the first began rather than start a rival
   * one, or the barrier would resolve on a teardown that is not the one
   * actually releasing the threads.
   *
   * The memoized promise carries a failure as readily as a success, which is
   * what keeps "at most once" honest for a pool that would not shut down: a
   * second attempt would only race the same refusal, so every caller is handed
   * the one answer this generation has. Each therefore attaches its own handler.
   * @param generation - Generation whose pool is to be destroyed.
   * @returns The single teardown of that generation; rejects when the pool
   * refused to shut down, and rejects again for every later caller.
   */
  private tearDown(generation: WorkerGeneration): Promise<void> {
    generation.teardown ??= generation.pool.destroy();
    return generation.teardown;
  }

  /**
   * Build the structured-clone-safe worker task for one invocation.
   *
   * Every invocation gets a fresh loader namespace so successive executions
   * never share a transpiled module cache.
   *
   * The task's `redactedPaths` is the single redaction set for this invocation,
   * and both sides of the thread boundary use it: the worker strips it before a
   * diagnostic can be truncated around a value the host would then no longer be
   * able to match, and the host strips it again from whatever reaches it.
   * @param request - Prepared invocation being dispatched.
   * @param materialized - Materialized program root for this invocation.
   * @param configuration - Pinned package targets and matching redactions.
   * @returns Task payload for the worker entry.
   */
  private createTask(
    request: AdmittedInvocationInput,
    materialized: MaterializedVirtualProgram,
    configuration: RuntimeConfiguration,
  ): CodeExecutionWorkerTask {
    return {
      entryNamespaceUrl: materialized.entryNamespaceUrl,
      parentUrl: materialized.parentUrl,
      programRootUrls: materialized.rootUrls,
      allowedPackages: [...configuration.packageRoots.keys()],
      exportName: request.program.exportName,
      arguments: request.arguments,
      namespace: `${NAMESPACE_PREFIX}-${randomUUID()}`,
      maxResultBytes: this.maxResultBytes,
      redactedPaths: [...materialized.redactedPaths, ...configuration.redactions],
    };
  }

  /**
   * Resolve the host-configured redactions once, on first use.
   *
   * Deferred out of the constructor because establishing a configured path's
   * real spelling is filesystem work, and composing a provider must not do I/O
   * for an execution that may never happen. Concurrent invocations share one
   * attempt, but only a successful resolution remains pinned.
   *
   * Resolving package targets deliberately happens under admission. A missing
   * target is a provider failure for that invocation; a retargeted symlink after
   * this snapshot cannot alter later materialization.
   *
   * The loader environment is submitted as worker *paths* rather than as
   * environment values, because every value in it names a host file the worker
   * is launched against and a startup failure quotes it as a path. Passing a
   * value that turned out not to be one costs nothing: path expansion absorbs
   * its own failures and falls back to the value itself, which is what the
   * environment branch would have redacted anyway.
   * @returns Pinned package targets and matching bus-diagnostic redactions.
   */
  private resolveRuntimeConfiguration(): Promise<RuntimeConfiguration> {
    if (this.runtimeConfiguration !== undefined) return this.runtimeConfiguration;

    const resolving = resolveConfiguredRuntime({
      environment: this.environment,
      packageRoots: this.packageRoots,
      workerPaths: [this.workerEntry, ...Object.values(this.workerLoaderEnv)],
    });
    this.runtimeConfiguration = resolving;
    // Retain only successful snapshots; identity protects a later attempt.
    void resolving.catch(() => {
      if (this.runtimeConfiguration === resolving) this.runtimeConfiguration = undefined;
    });
    return resolving;
  }

  /**
   * Create the current worker generation on first use.
   *
   * The pool is created lazily so a composed-but-unused provider never spawns
   * a thread, and it is configured with the explicit environment, bounded
   * concurrency, and idle reaping the host asked for. `minThreads` is pinned to
   * zero because the pool's own default keeps at least one thread alive
   * forever, which would make the configured idle timeout unobservable.
   *
   * The worker entry's own loader environment is applied last, so a host cannot
   * reconfigure the loader through {@link PiscinaCodeExecutionProviderOptions.environment} —
   * that loader is what holds the package map to being the whole truth about
   * which ordinary packages a submitted program resolves.
   *
   * Laziness is also what makes retirement cheap: a retired generation simply
   * clears this field, and the next invocation builds its successor on exactly
   * the path it would have taken for the very first execution.
   *
   * INVARIANT: this must only be reached from a call path that checked
   * `this.disposed` with no intervening `await`. Disposal clears the current
   * generation, so a revived provider would spawn threads no barrier is waiting
   * on; {@link runInvocation} carries the matching note, and every frame between
   * it and this one is synchronous.
   * @returns The live worker generation.
   */
  private acquireGeneration(): WorkerGeneration {
    if (this.generation !== undefined) return this.generation;
    const pool = new Piscina<CodeExecutionWorkerTask, unknown>({
      filename: this.workerEntry,
      execArgv: [...this.workerExecArgv],
      env: { ...this.environment, ...this.workerLoaderEnv },
      minThreads: 0,
      maxThreads: this.maxConcurrency,
      idleTimeout: this.idleTimeoutMs,
    });
    const generation: WorkerGeneration = {
      pool,
      submitted: 0,
      outstanding: 0,
      retired: false,
      failed: false,
    };
    // Register synchronously before publishing the generation. Piscina can emit
    // an error while bootstrapping its first worker, and EventEmitter treats an
    // unobserved `error` event as process-fatal.
    pool.on('error', (error: Error) => this.handlePoolError(generation, error));
    this.generation = generation;
    return this.generation;
  }

  /**
   * Map a worker outcome envelope onto a terminal contract outcome.
   *
   * The envelope is re-validated here, so a worker entry that returns
   * something else is reported as a provider contract violation rather than
   * widening the outcome union. The result budget is re-applied after the
   * thread boundary before mapping it onto the contract. The clone has already
   * happened by this point — this bounds what leaves the provider, not what
   * crosses the thread boundary.
   * @param workerOutcome - Raw value returned by the worker thread.
   * @param redactions - Full redaction set for this invocation.
   * @returns Terminal outcome for the invocation.
   */
  private toOutcome(workerOutcome: unknown, redactions: readonly string[]): CodeExecutionOutcome {
    const parsed = CodeExecutionWorkerOutcomeSchema.safeParse(workerOutcome);
    if (!parsed.success) {
      return failedOutcome('invalid_provider', 'The execution worker returned a malformed outcome envelope.');
    }
    if (parsed.data.kind === 'completed') {
      const bytes = measureSerializedBytes(parsed.data.value);
      if (bytes > this.maxResultBytes) {
        return failedOutcome(
          'invalid_result',
          `The execution returned ${bytes} serialized bytes, which exceeds the limit of ${this.maxResultBytes}.`,
        );
      }
      return { status: 'completed', value: parsed.data.value };
    }
    return failedOutcome(parsed.data.code, sanitizeDiagnosticMessage(parsed.data.message, redactions));
  }

  /**
   * Map a thrown failure onto a terminal contract outcome.
   *
   * Caller aborts never reach here: they are classified on the dispatch path,
   * where an abort rejection can be told apart from an unrelated failure.
   *
   * A pool torn down under a running task rejects it with the pool's own
   * teardown error, and the honest classification for that is the disposal
   * rather than a provider fault. Recognizing it takes *both* conditions: the
   * provider being disposed alone would relabel a genuine failure that merely
   * happened to land during disposal, and a teardown-shaped rejection alone
   * cannot be attributed to a disposal that is not happening.
   * @param error - Value thrown while admitting, materializing, or dispatching.
   * @param redactions - Full redaction set for this invocation.
   * @returns Terminal outcome for the invocation.
   */
  private toFailureOutcome(error: unknown, redactions: readonly string[]): CodeExecutionOutcome {
    if (error instanceof VirtualProgramError) {
      return failedOutcome(error.code, sanitizeDiagnosticMessage(error.message, redactions));
    }
    if (this.disposed && isPoolTeardownError(error)) return disposedOutcome();
    return failedOutcome('provider_failed', sanitizeDiagnosticMessage(describeThrownValue(error), redactions));
  }
}
