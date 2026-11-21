/**
 * One bounded command: spawned directly, as the leader of its own process
 * group, with a bounded run time, bounded captured output and a bounded stop.
 *
 * The result keeps how the leader ended apart from the evidence about its
 * group: a leader that exited may leave live members behind, and only a
 * positive proof counts as quiescent. See `process-tree.ts` for the signalling
 * rule: once the leader's close is observed, nothing is signalled any more.
 */
import { constants as bufferConstants } from 'node:buffer';
import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { mergeEnvironment } from './launch-env.js';
import { createOutputCapture, type LaunchCapturedOutput, type OutputCapture } from './launch-output.js';
import type { ProcessExit, ProcessTreeEvidence, UnobservedExitReason } from './process-end.js';
import {
  hostProcessSignals,
  proveProcessGroupQuiescence,
  spawnOptionsForOwnership,
  type ProcessSignalPort,
} from './process-tree.js';
import { LAUNCH_DRAIN_TIMEOUT_MS, LAUNCH_EXIT_OBSERVATION_MS, LAUNCH_KILL_GRACE_MS } from './stop-budget.js';
import { startStopEscalation, windowsTreeEvidence, type StopEscalation, type StopHost } from './stop-escalation.js';
import type { ProcessStopTiming, SpawnEnvMode, SubprocessSpawnOptions } from './types.js';

export type { LaunchCapturedOutput } from './launch-output.js';

/** Exit of a leader whose end was observed or given up on, never a failed spawn. */
type LeaderExit = Exclude<ProcessExit, { readonly kind: 'spawn-failed' }>;

/** What happens to the command's stdout and stderr. */
export type LaunchOutput =
  /** Both streams are discarded; nothing is retained. */
  | { readonly kind: 'ignore' }
  /**
   * Both streams are captured as UTF-8 text up to `limitBytes` in total. `limitBytes` is an integer from 0 to
   * `buffer.constants.MAX_STRING_LENGTH`; anything else is refused as `invalid-output-limit`. `0` keeps nothing:
   * the first byte of output ends the command as `output-limit`.
   */
  | { readonly kind: 'capture'; readonly limitBytes: number };

/** One bounded command. No shell parsing; `command` is spawned directly. */
export interface LaunchOptions extends SubprocessSpawnOptions {
  /**
   * Time, in milliseconds, between `SIGTERM` and `SIGKILL` on POSIX hosts. When set: a whole number from 0 to
   * 2147483647, else refused as `invalid-stop-timing`.
   */
  readonly killGraceMs?: ProcessStopTiming['killGraceMs'];
  /**
   * Time, in milliseconds, the exit is awaited after the forceful stage before it counts as unobserved. When set:
   * a whole number from 0 to 2147483647, else refused as `invalid-stop-timing`.
   */
  readonly exitObservationMs?: ProcessStopTiming['exitObservationMs'];
  /** How `env` becomes the child's environment. Required: every caller states it. */
  readonly envMode: SpawnEnvMode;
  /**
   * Longest run time in milliseconds: a whole number from 1 to 2147483647 (see {@link isValidLaunchTimeoutMs}).
   * Anything else is refused as `invalid-timeout`.
   */
  readonly timeoutMs: number;
  /** Cancels this one command. */
  readonly signal?: AbortSignal;
  readonly output: LaunchOutput;
  /**
   * Longest time, in milliseconds, the group's quiescence is awaited after the close. Defaults to 2000.
   * When set: a whole number from 1 to 2147483647, else refused as `invalid-stop-timing`.
   */
  readonly quiescenceProofTimeoutMs?: number;
  /**
   * Injectable signal primitive (tests); defaults to the host's.
   * @internal
   */
  readonly signalPort?: ProcessSignalPort;
  /**
   * Injectable platform facts (tests); defaults to the real host.
   * @internal
   */
  readonly stopHost?: StopHost;
}

export type LaunchStatus =
  // POSIX: `completed` and `failed` are reported only with the group proven quiescent.
  // Windows: there is no group to prove; without a stop they are reported WITHOUT a proof, and
  // `group.tree` says so (`unproven`, `no-termination`). A caller that needs the proof reads `group.tree`.
  | 'completed' // exit code 0
  | 'failed' // non-zero exit or ended by a signal nobody here sent
  | 'cancelled' // `signal` fired
  | 'timed-out' // `timeoutMs` elapsed
  | 'output-limit' // captured output exceeded `limitBytes`
  | 'spawn-failed' // no process ran; `refusal` says why
  | 'stop-failed'; // the exit stayed unobserved, or a stop did not prove the tree quiescent

/**
 * Why no process ran. A closed list that later packages extend by members (owner closed, cwd outside the
 * workspace, reserved environment entry, home unavailable); the form stays.
 *
 * - `invalid-timeout`: `timeoutMs` is not a whole number from 1 to 2147483647.
 * - `invalid-stop-timing`: a set `killGraceMs` or `exitObservationMs` is not a whole number from 0 to 2147483647,
 *   or a set `quiescenceProofTimeoutMs` is not a whole number from 1 to 2147483647.
 * - `invalid-output-limit`: the capture `limitBytes` is not an integer from 0 to `buffer.constants.MAX_STRING_LENGTH`.
 * - `command-not-found`, `spawn-error`, `unsupported-platform`: the host could not start the command.
 *   `command-not-found` means ENOENT with an existing working directory: Node reports a missing executable and a
 *   missing working directory alike, so the directory is checked after the failure and the answer is therefore
 *   not race-free. A missing working directory is a `spawn-error`.
 */
export type LaunchRefusal =
  | 'invalid-timeout'
  | 'invalid-stop-timing'
  | 'invalid-output-limit'
  | 'command-not-found'
  | 'spawn-error'
  | 'unsupported-platform';

/** Facts about the spawned process group, recorded by the launcher itself. */
export interface LaunchGroupFacts {
  readonly pid: number;
  /** Evidence about the group after the leader's close. Never `not-owned`: a launch always owns its group. */
  readonly tree: ProcessTreeEvidence;
  /** Whether a stop-phase signal reached an existing group. */
  readonly signalDelivered: boolean;
  /** Instant these facts were recorded. */
  readonly observedAt: Date;
}

export interface LaunchResult {
  readonly status: LaunchStatus;
  /**
   * How the leader ended. Absent exactly when no process ran (refused before the spawn, or the spawn failed):
   * `refusal` says why. Never the `spawn-failed` member of `ProcessExit`, whose `error` may name the command.
   */
  readonly exit?: LeaderExit;
  /** Present exactly when a process was spawned. */
  readonly group?: LaunchGroupFacts;
  /** Present exactly when `output.kind === 'capture'` and a process was spawned. Truncated at the limit. */
  readonly output?: LaunchCapturedOutput;
  /** Present exactly when `status === 'spawn-failed'`. */
  readonly refusal?: LaunchRefusal;
  /** Fixed, content-free diagnostic; never command arguments, never environment values. */
  readonly message?: string;
}

/** A started (or refused) command. Later packages add fields (streams) here; `result` stays. */
export interface LaunchedProcess {
  /** PID of the group leader; `undefined` when nothing was spawned. */
  readonly pid: number | undefined;
  /** Settles exactly once; never rejects. */
  readonly result: Promise<LaunchResult>;
}

/** The type of `launch`: the port at the operating-system boundary that callers take as a parameter. */
export type LaunchFunction = (options: LaunchOptions) => LaunchedProcess;

/** Longest time the group's quiescence is awaited after the close. */
const DEFAULT_QUIESCENCE_PROOF_TIMEOUT_MS = 2_000;

/** Fixed diagnostics; none carries a command argument or an environment value. */
const MESSAGES = {
  'invalid-timeout': 'Launch timeout must be an integer between 1 and 2147483647 milliseconds',
  'invalid-stop-timing':
    'Stop timing must be whole milliseconds: killGraceMs and exitObservationMs from 0, quiescenceProofTimeoutMs from 1, each up to 2147483647',
  'invalid-output-limit': 'Output limit must be an integer number of bytes from 0 up to the maximum string length',
  'command-not-found': 'The command was not found',
  'spawn-error': 'Could not start the command',
  'unsupported-platform': 'The command is not supported on this platform',
} as const;

/** Diagnostic of the `invalid-timeout` refusal, for callers that check the timeout before they launch. */
export const INVALID_LAUNCH_TIMEOUT_MESSAGE = MESSAGES['invalid-timeout'];

/** Fixed diagnostics of the statuses that carry one. */
const STATUS_MESSAGES: Partial<Record<LaunchStatus, string>> = {
  'stop-failed': 'The process group of the command was not proven stopped',
  'output-limit': 'The command exceeded the output limit',
};

/** Reasons that stop a running command; the first one decides the status. */
type StopReason = 'cancelled' | 'timed-out' | 'output-limit';

/** Longest delay Node schedules without coercing it to 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * One rule for every timer value: a whole number of milliseconds from a minimum up to Node's timer limit.
 * Infinity and NaN are not whole numbers, so they never leave a stop without an armed timer.
 * @param value - Requested duration in milliseconds.
 * @param minimum - Smallest accepted value.
 * @returns Whether the value can be scheduled without timer coercion.
 */
function isValidTimerMs(value: number, minimum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= MAX_TIMER_MS;
}

/**
 * Keep command deadlines within Node's timer range without overflow or truncation.
 * @param timeoutMs - Requested command timeout in milliseconds.
 * @returns Whether the timeout can be scheduled without timer coercion.
 */
export function isValidLaunchTimeoutMs(timeoutMs: number): boolean {
  return isValidTimerMs(timeoutMs, 1);
}

/**
 * Check the stop timing options that are set.
 * @param options - Options of the launch.
 * @returns Whether every set stop timing option is valid.
 */
function hasValidStopTiming(options: LaunchOptions): boolean {
  const { killGraceMs, exitObservationMs, quiescenceProofTimeoutMs } = options;
  return (
    (killGraceMs === undefined || isValidTimerMs(killGraceMs, 0)) &&
    (exitObservationMs === undefined || isValidTimerMs(exitObservationMs, 0)) &&
    (quiescenceProofTimeoutMs === undefined || isValidTimerMs(quiescenceProofTimeoutMs, 1))
  );
}

/**
 * Check the capture limit, when the output is captured.
 * @param output - Output handling of the launch.
 * @returns Whether the limit is absent or an integer a string can hold.
 */
function hasValidOutputLimit(output: LaunchOutput): boolean {
  return (
    output.kind !== 'capture' ||
    (Number.isInteger(output.limitBytes) &&
      output.limitBytes >= 0 &&
      output.limitBytes <= bufferConstants.MAX_STRING_LENGTH)
  );
}

/**
 * Whether a failed spawn means that the executable is missing. Node reports ENOENT for a missing executable and
 * for a missing working directory alike, so ENOENT counts only while the working directory exists. Never throws.
 * @param error - Error the failed spawn reported.
 * @param cwd - Working directory of the spawn.
 * @returns True for ENOENT with an existing working directory.
 */
function isMissingCommand(error: Error, cwd: string): boolean {
  if (!('code' in error) || error.code !== 'ENOENT') return false;
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A launch that ran no process.
 * @param status - `spawn-failed`, or `cancelled` for a signal that fired before the start.
 * @param refusal - Why no process ran; absent for `cancelled`.
 * @returns The settled handle.
 */
function refused(status: 'spawn-failed' | 'cancelled', refusal?: LaunchRefusal): LaunchedProcess {
  const result: LaunchResult = refusal === undefined ? { status } : { status, refusal, message: MESSAGES[refusal] };
  return { pid: undefined, result: Promise.resolve(result) };
}

/**
 * Spawn one command, bound its run time and output, and report how it ended
 * together with evidence about its process group.
 *
 * The command is spawned directly (no shell) as the leader of its own process
 * group. A timeout, the abort signal or the output limit stops it in bounded
 * stages (`startStopEscalation`); after the leader's close the group's
 * quiescence is proven, and a group that is not proven quiescent settles as
 * `stop-failed`, also for a command that exited with code 0. Never throws: a
 * refusal (invalid timeout, stop timing or output limit included) is an already settled `result`
 * and nothing is spawned.
 *
 * The proof covers the process group only: a descendant that left it
 * (`setsid`, `setpgid`) is neither stopped nor counted.
 *
 * Windows: carried, not exercised by any CI. Without a stop, `completed` and `failed`
 * are reported without a proof of the tree; `group.tree` says so.
 * @param options - Command, environment, bounds and output handling.
 * @returns The leader's PID and the result.
 */
export function launch(options: LaunchOptions): LaunchedProcess {
  if (options.signal?.aborted === true) return refused('cancelled');
  if (!isValidLaunchTimeoutMs(options.timeoutMs)) return refused('spawn-failed', 'invalid-timeout');
  if (!hasValidStopTiming(options)) return refused('spawn-failed', 'invalid-stop-timing');
  if (!hasValidOutputLimit(options.output)) return refused('spawn-failed', 'invalid-output-limit');
  let child: ChildProcess;
  try {
    child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: mergeEnvironment(process.env, options.env, options.envMode, options.stopHost?.platform ?? process.platform),
      shell: false,
      windowsHide: true,
      ...spawnOptionsForOwnership('process-group'),
      // Output is captured in memory under a bound; it is never retained on disk.
      stdio: options.output.kind === 'capture' ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    });
  } catch {
    return refused('spawn-failed', 'spawn-error');
  }
  return { pid: child.pid, result: new Run(child, options).result };
}

/** One running command: its timers, listeners and the single settle. */
class Run {
  private readonly host: StopHost | undefined;
  private readonly capture: OutputCapture | undefined;
  private readonly timeout: ReturnType<typeof setTimeout>;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private escalation: StopEscalation | undefined;
  private stopReason: StopReason | undefined;
  private leaderExit: LeaderExit | undefined;
  private settled = false;
  private resolve: (result: LaunchResult) => void = () => undefined;
  // A terminal status is no signal evidence: a group that exited between the leader's exit and its close
  // answers ESRCH, and a denied signal delivers nothing either. Only a signal that reached a group counts.
  private signalDelivered = false;

  /** Settles exactly once; never rejects. */
  public readonly result: Promise<LaunchResult>;

  /**
   * Wire the child.
   * @param child - The spawned (or failed) child.
   * @param options - Options of the launch.
   */
  public constructor(
    private readonly child: ChildProcess,
    private readonly options: LaunchOptions,
  ) {
    this.result = new Promise((resolve) => {
      this.resolve = resolve;
    });
    this.host = options.stopHost;
    this.capture =
      options.output.kind === 'capture'
        ? createOutputCapture(options.output.limitBytes, () => this.requestStop('output-limit'))
        : undefined;
    child.once('error', (error) => this.onError(error));
    child.once('exit', (code, signal) => this.onExit({ kind: 'exited', code, signal }));
    child.once('close', (code, signal) => this.onClose({ kind: 'exited', code, signal }));
    for (const stream of ['stdout', 'stderr'] as const) {
      // Pipe errors carry no result of their own; the close and the bounds settle the run.
      child[stream]?.on('error', () => undefined);
      child[stream]?.on('data', (chunk: Buffer | string) =>
        this.capture?.push(stream, typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
      );
    }
    this.timeout = setTimeout(() => this.requestStop('timed-out'), options.timeoutMs);
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    // An abort between the first check in `launch` and this registration fires no event.
    if (options.signal?.aborted === true) this.onAbort();
  }

  private readonly onAbort = (): void => this.requestStop('cancelled');

  /**
   * A failed spawn reports through `error` and has no PID; any other `error` of a started child is no end.
   * @param error - Error the child reported.
   */
  private onError(error: Error): void {
    if (this.child.pid !== undefined || this.settled) return;
    const refusal = isMissingCommand(error, this.options.cwd) ? 'command-not-found' : 'spawn-error';
    this.end();
    this.resolve({ status: 'spawn-failed', refusal, message: MESSAGES[refusal] });
  }

  /**
   * The leader exited: no further signal, and the pipes get a bounded drain. The bound is fixed; the stop
   * timing of the command does not shorten it.
   * @param exit - How the leader ended.
   */
  private onExit(exit: LeaderExit): void {
    if (this.settled || this.leaderExit !== undefined) return;
    this.leaderExit = exit;
    this.escalation?.cancel();
    this.drainTimer = setTimeout(() => {
      this.destroyPipes();
      this.settle(exit);
    }, LAUNCH_DRAIN_TIMEOUT_MS);
  }

  /**
   * The leader's pipes closed.
   * @param exit - How the leader ended, as `close` reports it.
   */
  private onClose(exit: LeaderExit): void {
    this.settle(this.leaderExit ?? exit);
  }

  /**
   * Stop the command for a reason. The first reason decides the status. An
   * exit that was already observed is not stopped again, but output beyond the
   * limit still counts.
   * @param reason - Why the command is stopped.
   */
  private requestStop(reason: StopReason): void {
    if (this.settled || this.stopReason !== undefined) return;
    const exitObserved = this.leaderExit !== undefined;
    if (exitObserved && reason !== 'output-limit') return;
    this.stopReason = reason;
    const pid = this.child.pid;
    if (exitObserved || pid === undefined) return;
    const base = this.options.signalPort ?? hostProcessSignals;
    this.escalation = startStopEscalation({
      pid,
      ownership: 'process-group',
      killGraceMs: this.options.killGraceMs ?? LAUNCH_KILL_GRACE_MS,
      exitObservationMs: this.options.exitObservationMs ?? LAUNCH_EXIT_OBSERVATION_MS,
      deadline: undefined,
      port: {
        kill: (target, signal) => {
          base.kill(target, signal);
          if (signal !== 0) this.signalDelivered = true;
        },
      },
      host: this.host,
      exitUnobserved: () => this.leaderExit === undefined && !this.settled,
      onUnobserved: (reason) => this.onUnobserved(reason),
      onSignalFailure: () => undefined,
    });
    void this.escalation.termination?.then((outcome) => {
      if (outcome === 'delivered') this.signalDelivered = true;
    });
  }

  /**
   * The stop gave up: the leader may run on and must not keep the host alive.
   * @param reason - Why the exit stayed unobserved.
   */
  private onUnobserved(reason: UnobservedExitReason): void {
    this.child.unref();
    this.destroyPipes();
    this.settle({ kind: 'unobserved', reason });
  }

  private destroyPipes(): void {
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }

  /** Clear every timer and listener of the run. */
  private end(): void {
    this.settled = true;
    clearTimeout(this.timeout);
    clearTimeout(this.drainTimer);
    this.options.signal?.removeEventListener('abort', this.onAbort);
  }

  /**
   * End the run once and conclude it with evidence about the group.
   * @param exit - How the leader ended, or that it stayed unobserved.
   */
  private settle(exit: LeaderExit): void {
    if (this.settled) return;
    this.end();
    this.escalation?.cancel();
    void this.conclude(exit).then(this.resolve);
  }

  /**
   * Gather the tree evidence and derive the status. Never rejects.
   * @param exit - How the leader ended.
   * @returns The result.
   */
  private async conclude(exit: LeaderExit): Promise<LaunchResult> {
    const pid = this.child.pid;
    if (pid === undefined) return { status: 'spawn-failed', refusal: 'spawn-error', message: MESSAGES['spawn-error'] };
    const windows = (this.host?.platform ?? process.platform) === 'win32';
    const tree = await this.observeTree(pid, windows);
    const group: LaunchGroupFacts = { pid, tree, signalDelivered: this.signalDelivered, observedAt: new Date() };
    const output = this.capture?.finish();
    // Windows without a stop has no tree termination to wait for: the status follows the exit code.
    const proofRequired = !windows || this.escalation !== undefined;
    const failed = exit.kind === 'unobserved' || (proofRequired && tree.kind !== 'quiescent');
    const status: LaunchStatus = failed
      ? 'stop-failed'
      : (this.stopReason ?? (exit.kind === 'exited' && exit.code === 0 ? 'completed' : 'failed'));
    const message = STATUS_MESSAGES[status];
    return {
      status,
      exit,
      group,
      ...(output === undefined ? {} : { output }),
      ...(message === undefined ? {} : { message }),
    };
  }

  /**
   * Evidence about the group after the leader's close. Nothing is signalled here.
   * @param pid - PID of the group leader.
   * @param windows - Whether the stop and the evidence follow the Windows ordering.
   * @returns The evidence; `unproven` when it could not be gathered.
   */
  private async observeTree(pid: number, windows: boolean): Promise<ProcessTreeEvidence> {
    if (!windows) {
      try {
        return await proveProcessGroupQuiescence(pid, {
          timeoutMs: this.options.quiescenceProofTimeoutMs ?? DEFAULT_QUIESCENCE_PROOF_TIMEOUT_MS,
          port: this.options.signalPort,
        });
      } catch {
        return { kind: 'unproven', reason: 'signal-error' };
      }
    }
    // A tree termination still running is joined for at most its own bound.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.options.exitObservationMs ?? LAUNCH_EXIT_OBSERVATION_MS);
    try {
      return await windowsTreeEvidence(this.escalation?.termination, abort.signal);
    } catch {
      return { kind: 'unproven', reason: 'signal-error' };
    } finally {
      clearTimeout(timer);
    }
  }
}
