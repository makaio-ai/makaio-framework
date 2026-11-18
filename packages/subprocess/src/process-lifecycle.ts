/**
 * Process lifecycle manager for supervised subprocess instances.
 *
 * Wraps spawn, readiness, bounded stop and an optional restart policy into a
 * single stateful handle. The lifecycle never touches a child process itself:
 * every run owns one JSONL transport, and the transport's end report
 * ({@link IJsonlTransport.ended}) is the only event that ends a run. stdout
 * carries only the readiness message, so the transport ignores the end of
 * stdout and the child stays supervised until it exits or is stopped.
 *
 * Transitions:
 * - `idle` | `stopped` | `crashed` → `starting` on `start()`, as a new generation.
 * - `starting` → `running` on the first message that is a JSON object.
 * - `starting` → `crashed` when the run ends first; `start()` rejects at once.
 * - `starting` → `crashed` when the health timeout comes first; `start()`
 *   rejects and the run is stopped. A later message changes nothing. Once the
 *   child's exit is observed the health timeout no longer applies: readiness is
 *   still decided by what the drained stdout delivers, and otherwise by the end.
 * - A new run starts only after the previous one has ended: a `start()` after a
 *   health timeout waits for the end of the run that is still stopping, and
 *   only then spawns. The state stays `crashed` meanwhile.
 * - `starting` | `running` | `crashed` → `stopping` on `stop()`, then
 *   `stopped` once the run has ended. A pending readiness is aborted and a
 *   pending restart dropped.
 * - `running` → `stopped` on an unexpected exit with code 0, or an end
 *   requested through the transport; `running` → `crashed` on any other end.
 *
 * A restart is automatic only under the restart policy, only after an observed
 * exit, only when no evidence suggests that a process of the old run outlived
 * it, and only within the restart budget. An exit that was never observed may
 * leave the old child running, and a pipe held past the drain deadline or a
 * process group not proven quiescent may leave its descendants running; a new
 * run could then register beside them, so none of these is restarted
 * automatically. An explicit `start()` stays allowed; {@link ProcessRunOutcome.exitObserved}
 * tells its caller when the old child's exit was finally observed.
 *
 * Members of an owned process group that outlive the child's observed exit are
 * reported, not stopped: the stop that a run's transport performs ends with that
 * exit (the signalling rule of `process-tree.ts`), and a later `stop()` has no
 * run left to stop. Such an end is logged and withholds an automatic restart.
 *
 * Every step (a `start()`, a `stop()`, readiness, the health timeout, the end
 * of a run) completes its bookkeeping first: the state, the restart decision
 * and the settlement of `start()`. Only then are the observers (`onStateChange`,
 * `onReady`, `onExit`) notified, in order, each isolated from the others. An
 * observer may call `start()` or `stop()`; that call sees the step's final
 * state, and its own notifications follow the ones already queued.
 * @packageDocumentation
 */

import type { IJsonlTransport, ProcessStopTiming, SubprocessSpawnOptions } from './types.js';
import { createJsonlTransport } from './jsonl-transport.js';
import {
  describeTransportEnd,
  mayHaveLeftProcesses,
  type ObservedProcessExit,
  type ProcessExit,
  type TransportEnd,
} from './process-end.js';
import type { ProcessSignalPort } from './process-tree.js';
import type { StopHost } from './stop-escalation.js';
import { createRestartBudget, type RestartBudget, type RestartBudgetOptions } from './restart-budget.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Valid states for the process lifecycle state machine. */
export type ProcessState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';

/**
 * Which ends of a ready run are followed by an automatic restart.
 * `none`: none. `on-crash`: every end except an exit with code 0.
 * `always`: every unexpected end.
 */
export type RestartPolicy = 'none' | 'on-crash' | 'always';

/**
 * How far a run got before it ended.
 * `ready`: it sent its readiness message.
 * `not-reached`: it ended on its own before readiness.
 * `health-timeout`: the health timeout came first, while the child's exit was
 * not yet observed, and the lifecycle stopped it.
 * `aborted`: `stop()` came first.
 */
export type RunReadiness = 'ready' | 'not-reached' | 'health-timeout' | 'aborted';

/**
 * What the lifecycle did about a restart once a run ended.
 * `none`: the policy asks for no restart, or the run was stopped.
 * `scheduled`: a restart follows after `delayMs`, unless `start()` or `stop()` comes first.
 * `withheld`: the policy asked for a restart, but the lifecycle stays where it is:
 * the exit was not observed (`exit-unobserved`), a process of the run may still
 * be alive because a pipe was held past the drain deadline or its process group
 * was not proven quiescent (`descendants-may-run`), or the restart budget is
 * used up (`budget-exhausted`). On Windows the lifecycle can prove a tree
 * quiescent only through a `taskkill` it ran itself, which an unexpected end
 * never has: a crash there is always `descendants-may-run`, so nothing restarts
 * automatically (an explicit `start()` stays allowed).
 * TODO(FACT-463): Windows Job Objects would let a crash prove its tree empty.
 */
export type RestartDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'scheduled'; readonly delayMs: number }
  | { readonly kind: 'withheld'; readonly reason: 'exit-unobserved' | 'descendants-may-run' | 'budget-exhausted' };

/** Everything the lifecycle reports, once per run, when that run has ended. */
export interface ProcessRunOutcome {
  /** Generation of the run: 1 for the first `start()`, increasing with every further one. */
  readonly generation: number;
  /** How far the run got; a health timeout is reported here, apart from the exit. */
  readonly readiness: RunReadiness;
  /** The transport's end report: cause, exit code and signal, drain, channel failure, tree evidence. */
  readonly end: TransportEnd;
  /**
   * The run's actual exit observation (the transport's `exitObserved`). It is
   * fulfilled already when `end.exit` is observed; after an `unobserved` end it
   * fulfils once the old child's exit is seen after all, and stays pending while
   * it is not, which is when an explicit `start()` could register a second child
   * beside the old one.
   */
  readonly exitObserved: Promise<ObservedProcessExit>;
  /** What the lifecycle did about a restart. */
  readonly restart: RestartDecision;
}

/** Configuration for process lifecycle management. */
export interface ProcessLifecycleOptions {
  /** Subprocess spawn options. */
  readonly spawn: SubprocessSpawnOptions;
  /** Time to wait for the readiness message before the start fails, in milliseconds. Default: 30000. */
  readonly healthTimeoutMs?: number;
  /**
   * Bounded phases of the end of every run: the kill grace between `SIGTERM`
   * and `SIGKILL`, the exit observation after `SIGKILL`, and the drain after the
   * exit. Omitted fields take the JSONL transport's defaults.
   */
  readonly stopTiming?: ProcessStopTiming;
  /**
   * When a ready run is restarted automatically. Default: `none`. On Windows an
   * unexpected end is never restarted automatically while the lifecycle owns the
   * tree (see {@link RestartDecision}).
   */
  readonly restartPolicy?: RestartPolicy;
  /** Limits of automatic restarts; see {@link RestartBudgetOptions} for the defaults. */
  readonly restartBudget?: RestartBudgetOptions;
  /**
   * Whether the lifecycle owns the processes the child starts, not only the
   * child: a stop signals its process group, and every end reports whether the
   * group went quiet. Default: `true`; see `JsonlTransportOptions.terminateTree`
   * for its reach and side effects.
   */
  readonly terminateTree?: boolean;
  /** POSIX signal primitive for stop signals. Defaults to the host's `process.kill`. */
  readonly signalPort?: ProcessSignalPort;
  /**
   * Host facts a stop depends on; defaults to the real host. A test seam that
   * simulates Windows on a POSIX host (see `JsonlTransportOptions.stopHost`).
   * @internal
   */
  readonly stopHost?: StopHost;
  /** Called when a run signals readiness, after `start()` was settled. */
  readonly onReady?: () => void;
  /** Called once per run, after its end was reported and the lifecycle acted on it. */
  readonly onExit?: (outcome: ProcessRunOutcome) => void;
  /** Called on every state transition, once the step that made it is complete. */
  readonly onStateChange?: (state: ProcessState) => void;
}

/** Options of {@link ProcessLifecycleHandle.start}. */
export interface ProcessStartOptions {
  /**
   * Cancels the start. When it aborts while the start is pending (a run waiting
   * for its readiness, or a previous run still ending), the lifecycle is stopped
   * exactly as by `stop()`, so the same guarantees hold: the readiness wait is
   * aborted, its subscriptions are removed, a pending automatic restart is
   * dropped and the child is stopped within its bounded stop. `start()` then
   * rejects. A signal that is already aborted rejects with its reason before
   * anything is spawned. A start that settled before the signal aborted is not
   * affected: stopping a running child stays the owner's `stop()`.
   */
  readonly signal?: AbortSignal;
}

/** Handle for a managed subprocess lifecycle. */
export interface ProcessLifecycleHandle {
  /** Transport of the current run, until that run has ended. */
  readonly transport: IJsonlTransport | undefined;
  /** Generation of the most recent run; 0 before the first `start()`. */
  readonly generation: number;
  /**
   * Spawn a new run and wait for its readiness: the first stdout message that
   * is a JSON object. Rejects when the run ends first (a failed spawn rejects
   * at once), when the health timeout elapses while the child still runs, or
   * when `stop()` aborts it.
   *
   * A new run starts only after the previous one has ended. After a health
   * timeout the previous run is still being stopped, so this call first waits
   * for its end (bounded by the stop timing) and spawns afterwards; the state
   * stays `crashed` meanwhile, and a `stop()` or another `start()` that comes
   * first rejects this call without spawning anything.
   * @param options - Start options; see {@link ProcessStartOptions}.
   */
  start(options?: ProcessStartOptions): Promise<void>;
  /**
   * Stop the current run and drop a pending restart. Sends `SIGTERM`, then
   * `SIGKILL` after the kill grace; every phase is bounded, and a run that may
   * have left a process behind (an unobserved exit, a held pipe, an unproven
   * process group) is reported with a warning. Idempotent.
   *
   * `stopped` is reached only once no run is left: a run that a health timeout
   * left stopping is ended first (a `start()` waits for it, see
   * {@link ProcessLifecycleHandle.start}), so no superseded run outlives it.
   */
  stop(): Promise<void>;
  /** Current lifecycle state. */
  readonly state: ProcessState;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Allowed state transitions keyed by current state. */
const VALID_TRANSITIONS: Readonly<Record<ProcessState, readonly ProcessState[]>> = {
  idle: ['starting'],
  starting: ['running', 'crashed', 'stopping'],
  running: ['stopping', 'stopped', 'crashed'],
  stopping: ['stopped'],
  stopped: ['starting'],
  crashed: ['starting', 'stopping'],
};

const NO_RESTART: RestartDecision = { kind: 'none' };

/** One spawned run of the child. */
interface Run {
  readonly generation: number;
  readonly transport: IJsonlTransport;
  /** Settles the `start()` that spawned this run. */
  readonly started: PromiseWithResolvers<void>;
  /** `pending` until readiness, the health timeout, `stop()` or the end decides it. */
  readiness: RunReadiness | 'pending';
  /** Clear the health timer and the readiness subscription. */
  readonly stopWaiting: () => void;
}

/** What one `start()` call knows about the run it spawned. */
interface StartAttempt {
  /** The run this start spawned; unset while it still waits for the previous run to end. */
  run?: Run;
}

/**
 * Report whether a message counts as readiness.
 * @param message - Parsed stdout message.
 * @returns `true` for a JSON object (not an array, not `null`).
 */
function isJsonObject(message: unknown): boolean {
  return typeof message === 'object' && message !== null && !Array.isArray(message);
}

/**
 * Report whether an exit was clean: code 0 and no signal.
 * @param exit - Process exit of an ended run.
 * @returns `true` only for an observed exit with code 0.
 */
function isCleanExit(exit: ProcessExit): boolean {
  return exit.kind === 'exited' && exit.code === 0 && exit.signal === null;
}

/** State machine over the runs of one child. See the module documentation. */
class ProcessLifecycle implements ProcessLifecycleHandle {
  private lifecycleState: ProcessState = 'idle';
  private generationCount = 0;
  /** The current run until its end was handled. */
  private run: Run | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  /** The stop in progress: defined exactly while the state is `stopping`; settles on `stopped`. */
  private stopping: PromiseWithResolvers<void> | undefined;
  /** Observer calls of the steps in progress, delivered once their bookkeeping is complete. */
  private readonly notices: Array<() => void> = [];
  private notifying = false;
  private readonly budget: RestartBudget;
  private readonly name: string;
  private readonly healthTimeoutMs: number;

  /**
   * @param options - Lifecycle configuration.
   */
  public constructor(private readonly options: ProcessLifecycleOptions) {
    this.name = options.spawn.processName ?? options.spawn.command;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 30_000;
    this.budget = createRestartBudget(options.restartBudget);
  }

  public get transport(): IJsonlTransport | undefined {
    return this.run?.transport;
  }

  public get generation(): number {
    return this.generationCount;
  }

  public get state(): ProcessState {
    return this.lifecycleState;
  }

  public async start(options: ProcessStartOptions = {}): Promise<void> {
    const { signal } = options;
    signal?.throwIfAborted();
    // The cancellation is the abort path `stop()` already has (I10): it is not
    // reimplemented here, only requested. It applies while this start is
    // unsettled: once the run it spawned has decided its readiness (ready, timed
    // out, stopped or ended) an abort has no effect, even when it is raised by
    // the observer that readiness notified, before the listener is removed below.
    const attempt: StartAttempt = {};
    const onAbort = (): void => {
      if (attempt.run === undefined || attempt.run.readiness === 'pending') void this.stop();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await this.startRun(attempt);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Spawn a new run, once the previous one has ended, and wait for its readiness.
   * @param attempt - The start's record, which receives the run once it is spawned.
   * @returns Settles with the run's readiness.
   */
  private async startRun(attempt: StartAttempt): Promise<void> {
    assertTransition(this.lifecycleState, 'starting');
    this.cancelRestart();
    // A run that is still current while the lifecycle may start is the one a
    // health timeout left stopping (every other end clears it). Its end is
    // awaited, not tracked: a second child must not run beside it, and `stop()`
    // must not resolve while it still does. The end report is bounded by the
    // stop timing. `stop()` or another `start()` may take the lifecycle out of
    // `crashed` meanwhile; this start was then overtaken and spawns nothing.
    const stopping = this.run;
    if (stopping !== undefined) {
      await stopping.transport.ended;
      if (this.lifecycleState !== 'crashed') {
        throw new Error(`Process start aborted while the previous run was ending: ${this.name}`);
      }
    }
    const run = this.launch();
    attempt.run = run;
    this.transition('starting');
    this.flushNotices();
    return run.started.promise;
  }

  public stop(): Promise<void> {
    this.cancelRestart();
    if (this.stopping !== undefined) return this.stopping.promise;
    if (this.lifecycleState === 'idle' || this.lifecycleState === 'stopped') return Promise.resolve();
    // Published before any observer can re-enter, so a nested stop() joins this one.
    const stop = Promise.withResolvers<void>();
    this.stopping = stop;
    const run = this.run;
    if (run !== undefined && this.claimReadiness(run, 'aborted')) {
      run.started.reject(new Error(`Process start aborted by stop(): ${this.name}`));
    }
    this.transition('stopping');
    // The end of the current run completes the stop; without a run nothing is left to end.
    if (run === undefined) this.finishStop();
    else void run.transport.close();
    this.flushNotices();
    return stop.promise;
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /**
   * Spawn a new run and wait for its readiness, its health timeout and its end.
   * @returns The run, now current.
   */
  private launch(): Run {
    const { spawn, stopTiming, terminateTree, signalPort, stopHost } = this.options;
    // stdout only carries the readiness message; the child stays supervised
    // until it exits or is stopped, whatever happens to stdout afterwards.
    const transport = createJsonlTransport({
      ...spawn,
      ...stopTiming,
      onStdoutEnd: 'ignore',
      finalLine: 'discard',
      terminateTree,
      signalPort,
      stopHost,
    });
    const subscriptions: Array<() => void> = [];
    const run: Run = {
      generation: ++this.generationCount,
      transport,
      started: Promise.withResolvers<void>(),
      readiness: 'pending',
      stopWaiting: () => {
        for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
      },
    };
    const healthTimer = setTimeout(() => this.timeOutReadiness(run), this.healthTimeoutMs);
    subscriptions.push(
      () => clearTimeout(healthTimer),
      transport.onMessage((message) => {
        if (isJsonObject(message)) this.becomeReady(run);
      }),
    );
    // The health timeout claims a child that runs without becoming ready. Once
    // its exit is observed it can no longer claim it: a readiness line written
    // before the exit may still be in the pipe, so the drained output decides,
    // and the end report rejects `start()` with the real cause otherwise.
    void transport.exitObserved.then(() => clearTimeout(healthTimer));
    void transport.ended.then((end) => this.handleRunEnd(run, end));
    this.run = run;
    return run;
  }

  /**
   * Decide a pending readiness, once; whatever decides it first wins.
   * @param run - Run whose readiness is decided.
   * @param readiness - How far the run got.
   * @returns `true` when this call decided it.
   */
  private claimReadiness(run: Run, readiness: RunReadiness): boolean {
    if (run.readiness !== 'pending') return false;
    run.readiness = readiness;
    run.stopWaiting();
    return true;
  }

  /**
   * The run sent its readiness message.
   * @param run - Run that became ready.
   */
  private becomeReady(run: Run): void {
    if (!this.claimReadiness(run, 'ready')) return;
    this.transition('running');
    run.started.resolve();
    const { onReady } = this.options;
    if (onReady !== undefined) this.notices.push(onReady);
    this.flushNotices();
  }

  /**
   * The health timeout elapsed before readiness: the start fails, and the run
   * is stopped. Its end is reported separately, once it arrives.
   * @param run - Run that did not become ready in time.
   */
  private timeOutReadiness(run: Run): void {
    if (!this.claimReadiness(run, 'health-timeout')) return;
    this.transition('crashed');
    run.started.reject(new Error(`Process health timeout after ${this.healthTimeoutMs}ms: ${this.name}`));
    void run.transport.close();
    this.flushNotices();
  }

  /**
   * Act on the end of a run: the only event that ends one. It is always the
   * current run: a new run is spawned only after the previous one's end was
   * handled (see {@link ProcessLifecycleHandle.start}).
   * @param run - Run that ended.
   * @param end - Its end report.
   */
  private handleRunEnd(run: Run, end: TransportEnd): void {
    const readiness: RunReadiness = run.readiness === 'pending' ? 'not-reached' : run.readiness;
    const endedBeforeReadiness = this.claimReadiness(run, readiness);
    let restart = NO_RESTART;
    this.run = undefined;
    if (endedBeforeReadiness) this.transition('crashed');
    else if (this.lifecycleState === 'running') restart = this.settleRunningEnd(end);
    else if (this.lifecycleState === 'stopping') this.finishStop();
    // `crashed` after a health timeout: the end changes nothing.
    if (endedBeforeReadiness) {
      run.started.reject(new Error(`${this.name} ${describeTransportEnd(end)} before signalling readiness`));
    }
    // Every end that may have left a process behind is reported, a requested
    // stop included: the stop's caller has no other way to learn of it.
    if (mayHaveLeftProcesses(end)) {
      const withheld = restart.kind === 'withheld' && restart.reason !== 'budget-exhausted';
      console.warn(
        `[ProcessLifecycle:${this.name}] generation ${run.generation} may have left processes running (${describeTransportEnd(end)})${withheld ? '; no automatic restart' : ''}`,
      );
    }
    const { onExit } = this.options;
    if (onExit !== undefined) {
      const outcome: ProcessRunOutcome = {
        generation: run.generation,
        readiness,
        end,
        exitObserved: run.transport.exitObserved,
        restart,
      };
      this.notices.push(() => onExit(outcome));
    }
    this.flushNotices();
  }

  /**
   * Classify the end of a ready run and apply the restart policy.
   * @param end - End report of the run.
   * @returns What was done about a restart.
   */
  private settleRunningEnd(end: TransportEnd): RestartDecision {
    if (end.cause === 'requested') {
      // Closed through the exposed transport rather than `stop()`.
      this.transition('stopped');
      return NO_RESTART;
    }
    const clean = isCleanExit(end.exit);
    this.transition(clean ? 'stopped' : 'crashed');
    const policy = this.options.restartPolicy ?? 'none';
    if (policy === 'none' || (clean && policy === 'on-crash')) return NO_RESTART;
    // The old child, or a process it started, may still run: a new one could
    // register beside it. The end is logged by the caller.
    if (end.exit.kind === 'unobserved') return { kind: 'withheld', reason: 'exit-unobserved' };
    if (mayHaveLeftProcesses(end)) return { kind: 'withheld', reason: 'descendants-may-run' };
    const grant = this.budget.claim();
    if (grant.kind === 'exhausted') {
      console.warn(
        `[ProcessLifecycle:${this.name}] restart budget exhausted (${this.budget.maxRestarts} restarts within ${this.budget.windowMs}ms); staying ${this.lifecycleState}`,
      );
      return { kind: 'withheld', reason: 'budget-exhausted' };
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start().catch((err: unknown) => {
        console.error(`[ProcessLifecycle:${this.name}] Restart failed:`, err instanceof Error ? err.message : err);
      });
    }, grant.delayMs);
    return { kind: 'scheduled', delayMs: grant.delayMs };
  }

  // -------------------------------------------------------------------------
  // Stop, state and observers
  // -------------------------------------------------------------------------

  /** Complete the stop in progress: `stopping` → `stopped`. */
  private finishStop(): void {
    this.transition('stopped');
    this.stopping?.resolve();
    this.stopping = undefined;
  }

  /** Drop a scheduled automatic restart. */
  private cancelRestart(): void {
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  /**
   * Transition to a new state and queue the onStateChange notification.
   * @param next - The state to transition into.
   */
  private transition(next: ProcessState): void {
    assertTransition(this.lifecycleState, next);
    this.lifecycleState = next;
    const { onStateChange } = this.options;
    if (onStateChange !== undefined) this.notices.push(() => onStateChange(next));
  }

  /**
   * Deliver the queued observer calls in order, each isolated: a throwing
   * observer is logged and changes nothing. A step that an observer starts
   * queues its own calls behind the pending ones, which this loop delivers.
   */
  private flushNotices(): void {
    if (this.notifying) return;
    this.notifying = true;
    for (let notice = this.notices.shift(); notice !== undefined; notice = this.notices.shift()) {
      try {
        notice();
      } catch (error) {
        console.error(`[ProcessLifecycle:${this.name}] observer threw`, error);
      }
    }
    this.notifying = false;
  }
}

/**
 * Guard that throws if the requested transition is not allowed.
 * @param from - Current state.
 * @param to - Desired next state.
 */
function assertTransition(from: ProcessState, to: ProcessState): void {
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid state transition: ${from} → ${to}`);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a managed process lifecycle handle.
 *
 * The handle begins in the `idle` state. Call {@link ProcessLifecycleHandle.start}
 * to spawn the subprocess.
 * @param options - Lifecycle configuration.
 * @returns Handle for controlling the subprocess lifecycle.
 */
export function createProcessLifecycle(options: ProcessLifecycleOptions): ProcessLifecycleHandle {
  return new ProcessLifecycle(options);
}
