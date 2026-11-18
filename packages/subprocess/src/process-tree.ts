/**
 * Stop ownership of the processes a spawned child starts.
 *
 * An owner decides up front how far its stop reaches:
 *
 * - `direct-child`: the owner stops the child it spawned and nothing else.
 *   Descendants the child starts are the child's concern.
 * - `process-group`: the owner stops everything the child starts. On POSIX the
 *   child is spawned as the leader of an isolated process group and the whole
 *   group is signalled through the negated leader PID. On Windows the tree is
 *   found through parent links and terminated forcefully in one stage by
 *   {@link terminateWindowsProcessTree}; there is no graceful first stage.
 *
 * A third kind, a stop delegated to a supervisor that owns the session, never
 * reaches these primitives: the supervisor keeps its own stop contract.
 *
 * The evidence these primitives produce is kept apart from the child's own
 * exit: a leader that exited may leave live members in its group, and only
 * {@link proveProcessGroupQuiescence} proves that none are left.
 *
 * Signalling rule, the same for every owner of a POSIX process group: once the
 * owner has observed the leader's exit, the group gets no further signal. A
 * group ID is reserved only while the group has a member, and a probe
 * (`kill(-pid, 0)`, the process table) cannot prove that the group it found is
 * still the one the owner spawned when the next signal resolves the number
 * again: the last member can end, and a new group take the ID, between the two.
 * A member that outlives the leader is therefore reported (see
 * {@link proveProcessGroupQuiescence}), not signalled. Before the exit is
 * observed the owner still addresses its own child's group, which is the best
 * evidence it can have; it is not a kernel guarantee, because the runtime reaps
 * a child before it dispatches the exit callback, so an exit the owner has not
 * observed yet may already have been reaped. This rule is about POSIX group
 * numbers only: a Windows tree is addressed by PID through
 * {@link terminateWindowsProcessTree}, a separate contract.
 *
 * A POSIX stop and its proof reach the child's process group, not every
 * descendant: a process that leaves the group (`setsid`, `setpgid`, a
 * daemonising tool, or a nested owner that isolates its own child with
 * `process-group` ownership) is neither signalled with the group nor counted by
 * the proof.
 *
 * Side effects of `process-group` on POSIX: the child runs in a new session, so
 * it leaves the host's foreground process group and has no controlling terminal.
 * Signals aimed at the host's terminal job no longer reach it: `SIGINT` and
 * `SIGQUIT` from the keyboard, `SIGHUP` when the terminal hangs up, and a
 * supervisor's kill of the host's group. Opening `/dev/tty` fails (`ENXIO`). Any
 * child outlives a host that dies without stopping it; a child in its own
 * session also misses the terminal signals that used to end it together with
 * the host, so it must exit by itself, for example when its stdin closes.
 */
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { TreeQuiescenceGap } from './process-end.js';

/** How far an owner's stop reaches; see the module documentation. */
export type StopOwnership = 'direct-child' | 'process-group';

/** Spawn options that establish a {@link StopOwnership}; spread them into `spawn()` options. */
export interface OwnershipSpawnOptions {
  /** Whether the child starts as the leader of a new session and process group. */
  readonly detached: boolean;
}

/**
 * Outcome of one signal or forceful termination sent to owned processes.
 * `delivered`: the host accepted the signal for at least one process.
 * `absent`: nothing was left to signal (`ESRCH`).
 * `denied`: the host refused the signal (`EPERM`). This proves nothing either
 *   way: Darwin answers `EPERM` for a group whose only members are zombies.
 */
export type SignalDelivery = 'delivered' | 'absent' | 'denied';

/**
 * The signal primitive, injectable so an owner can be driven into a denied or
 * failing signal against a real child.
 */
export interface ProcessSignalPort {
  /**
   * Send a signal with the semantics of `process.kill`: a negative PID addresses
   * a process group, and signal `0` only checks that the target exists.
   * Throws the host's errno error when the signal cannot be sent.
   */
  readonly kill: (pid: number, signal: NodeJS.Signals | 0) => void;
}

/** Why a group stayed unproven by {@link proveProcessGroupQuiescence}. */
export type GroupQuiescenceGap = Extract<TreeQuiescenceGap, 'poll-timeout' | 'ps-unavailable' | 'signal-error'>;

/**
 * Result of a bounded quiescence proof of a POSIX process group.
 * `quiescent`: no live member is left; zombies that wait to be reaped count as gone.
 * `unproven`: live members may remain; `reason` says why no proof was found.
 */
export type GroupQuiescenceProof =
  | { readonly kind: 'quiescent' }
  | { readonly kind: 'unproven'; readonly reason: GroupQuiescenceGap };

/** Inputs to {@link proveProcessGroupQuiescence}. */
export interface GroupQuiescenceOptions {
  /** Upper bound for the whole proof, in milliseconds. */
  readonly timeoutMs: number;
  /** Signal primitive for the group probe; defaults to the host's `process.kill`. */
  readonly port?: ProcessSignalPort;
  /**
   * Ends the proof early, for an owner whose own deadline moved forward. An
   * aborted proof that found no proof yet reports `poll-timeout`; the first
   * probe still runs when the signal is already aborted.
   */
  readonly signal?: AbortSignal;
}

/** Inputs to {@link terminateWindowsProcessTree}. */
export interface WindowsTreeTerminationOptions {
  /** Upper bound for the `taskkill` run, in milliseconds. */
  readonly timeoutMs: number;
}

/**
 * Why {@link terminateWindowsProcessTree} could not confirm its termination.
 * `timed-out`: `taskkill` did not finish within its bound; nothing was refused.
 * `failed`: `taskkill` reported a failure other than a missing process.
 */
export type WindowsTreeTerminationFailure = 'timed-out' | 'failed';

/** Rejection of {@link terminateWindowsProcessTree}; names the outcome, never `taskkill`'s output. */
export class WindowsTreeTerminationError extends Error {
  /**
   * @param failure - Why the termination is unconfirmed.
   * @param detail - Exit code or signal of the `taskkill` run.
   * @param pid - Root of the tree.
   * @param cause - Error reported by the `taskkill` run.
   */
  public constructor(
    public readonly failure: WindowsTreeTerminationFailure,
    detail: string,
    pid: number,
    cause: Error,
  ) {
    super(`taskkill ${failure === 'timed-out' ? 'timed out' : `failed (${detail})`} for process tree ${pid}`, {
      cause,
    });
    this.name = 'WindowsTreeTerminationError';
  }
}

/** Signal primitive of the host. `process.kill` is resolved per call, never captured. */
const hostProcessSignals: ProcessSignalPort = {
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
};

/** Pause between two probes of the same group. */
const PROBE_INTERVAL_MS = 20;
/** Upper bound for one `ps` query inside a proof. */
const MAX_PS_QUERY_MS = 1_000;
/** Bound for the `ps` output of one query; a process table never comes close. */
const MAX_PS_OUTPUT_BYTES = 1024 * 1024;
/** `taskkill` exit code when the addressed process does not exist. */
const TASKKILL_PROCESS_NOT_FOUND = 128;

/**
 * Tagged liveness of a group after one probe. `psMissing` is set only when the
 * host has no `ps` executable at all, the one failure no later probe in the same
 * proof can recover from.
 */
type GroupLiveness = { readonly alive: false } | { readonly alive: true; readonly psMissing?: true };

/**
 * Read the errno code of a thrown value without trusting its shape.
 * @param error - Value thrown by a host call.
 * @returns The string errno code, when there is one.
 */
function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Refuse a PID that would not address a spawned child. `kill(0)` and `kill(-0)`
 * address the caller's own process group, and `kill(-1)` every process the
 * caller may signal; no spawned child has PID 0 or 1.
 * @param pid - PID handed to a primitive of this module.
 */
function assertChildPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 2) {
    throw new RangeError(`Expected the PID of a spawned child, got ${String(pid)}`);
  }
}

/**
 * Refuse process-group operations on a host that has no process groups.
 * @param operation - Operation named in the error.
 */
function assertPosixHost(operation: string): void {
  if (process.platform === 'win32') {
    throw new Error(`${operation} requires a POSIX host; use terminateWindowsProcessTree on Windows`);
  }
}

/**
 * Build the spawn options that establish an ownership. A POSIX process group is
 * isolated with `detached`. Windows addresses a tree through parent links
 * instead; `detached` there would only give the child a console of its own.
 * @param ownership - How far the owner's stop reaches.
 * @returns Options to spread into the `spawn()` options of the child.
 */
export function spawnOptionsForOwnership(ownership: StopOwnership): OwnershipSpawnOptions {
  return { detached: ownership === 'process-group' && process.platform !== 'win32' };
}

/**
 * Send a signal to the processes an owner is responsible for: the child itself,
 * or its whole POSIX process group. Process groups do not exist on Windows; a
 * Windows tree is ended with {@link terminateWindowsProcessTree}.
 * @param ownership - Whether the child alone or its process group is addressed.
 * @param pid - PID of the spawned child, which leads its group under `process-group`.
 * @param signal - Signal to send.
 * @param port - Signal primitive; defaults to the host's `process.kill`.
 * @returns How the host answered; any error other than `ESRCH` or `EPERM` is thrown.
 */
export function signalOwnedProcesses(
  ownership: StopOwnership,
  pid: number,
  signal: NodeJS.Signals,
  port: ProcessSignalPort = hostProcessSignals,
): SignalDelivery {
  assertChildPid(pid);
  if (ownership === 'process-group') assertPosixHost('Signalling a process group');
  try {
    port.kill(ownership === 'process-group' ? -pid : pid, signal);
    return 'delivered';
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ESRCH') return 'absent';
    if (code === 'EPERM') return 'denied';
    throw error;
  }
}

/**
 * Prove within a bound that no live process is left in a POSIX process group.
 *
 * `kill(-pid, 0)` answering `ESRCH` proves the group gone. Any other answer is no
 * proof: unreaped zombies keep a group addressable although they can no longer
 * run, and Darwin answers `EPERM` for a zombie-only group. Those cases need the
 * host process table (`ps -A -o pgid=,stat=`): the group is quiescent when it
 * lists the group and every listed member is a zombie. Unreadable output, an
 * unlisted group or a live member keep the probe going until the deadline.
 * @param pid - Leader PID, which names the group.
 * @param options - Deadline and signal primitive of the proof.
 * @returns `quiescent`, or `unproven` with the reason the proof failed.
 */
export async function proveProcessGroupQuiescence(
  pid: number,
  options: GroupQuiescenceOptions,
): Promise<GroupQuiescenceProof> {
  assertChildPid(pid);
  assertPosixHost('Proving a process group quiescent');
  const port = options.port ?? hostProcessSignals;
  const { signal } = options;
  const deadline = Date.now() + options.timeoutMs;
  let psMissing = false;
  // The remaining budget is read once per round, so a `ps` query never gets a
  // non-positive timeout, which `execFile` would treat as no timeout at all.
  for (let remaining = options.timeoutMs; remaining > 0; remaining = deadline - Date.now()) {
    let liveness: GroupLiveness;
    try {
      liveness = await probeGroupLiveness(pid, Math.min(MAX_PS_QUERY_MS, remaining), psMissing, port, signal);
    } catch {
      // A host that cannot even probe the group gives no proof at all.
      return { kind: 'unproven', reason: 'signal-error' };
    }
    if (!liveness.alive) return { kind: 'quiescent' };
    psMissing = psMissing || liveness.psMissing === true;
    if (signal?.aborted === true) break;
    try {
      await delay(PROBE_INTERVAL_MS, undefined, { signal });
    } catch {
      break;
    }
  }
  // Only a permanently missing ps is `ps-unavailable`; a proof that ended with
  // recoverable query failures simply ran out of time.
  return { kind: 'unproven', reason: psMissing ? 'ps-unavailable' : 'poll-timeout' };
}

/**
 * Probe a group once: `kill(-pid, 0)` first, the process table when that is no proof.
 * @param pid - Leader PID of the group.
 * @param psTimeoutMs - Remaining bounded time for the `ps` query.
 * @param psMissing - Whether an earlier probe of this proof found no `ps` at all.
 * @param port - Signal primitive for the group probe.
 * @param signal - Aborts a pending `ps` query; the probe then counts as no proof.
 * @returns Tagged liveness, noting a permanently missing `ps` for the caller.
 */
async function probeGroupLiveness(
  pid: number,
  psTimeoutMs: number,
  psMissing: boolean,
  port: ProcessSignalPort,
  signal: AbortSignal | undefined,
): Promise<GroupLiveness> {
  try {
    port.kill(-pid, 0);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ESRCH') return { alive: false };
    // Darwin can answer EPERM for a zombie-only group. It proves neither
    // liveness nor quiescence; require the same positive ps evidence below.
    if (code !== 'EPERM') throw error;
  }
  // A host without a ps executable does not grow one mid-proof, so spend the
  // remaining budget on the cheap group probe instead of the same failure.
  // An aborted proof spends nothing more on ps either.
  if (psMissing || signal?.aborted === true) return { alive: true };
  let stdout: string;
  try {
    stdout = await readProcessGroups(psTimeoutMs, signal);
  } catch (error) {
    // Without ps evidence, wait conservatively for ESRCH instead. Only a missing
    // ps latches; a timed-out or transiently failing query is retried on the
    // next round, inside the same deadline.
    return errnoCode(error) === 'ENOENT' ? { alive: true, psMissing: true } : { alive: true };
  }
  let sawGroup = false;
  for (const line of stdout.trim().split('\n')) {
    const [group, state, extra] = line.trim().split(/\s+/);
    if (group === '' || state === undefined || extra !== undefined || !/^\d+$/.test(group) || state === '') {
      return { alive: true };
    }
    if (Number(group) !== pid) continue;
    sawGroup = true;
    if (!state.startsWith('Z')) return { alive: true };
  }
  // sawGroup: every listed member is a zombie, so the group is quiescent.
  // Otherwise the table does not list a group the probe still found: stay conservative.
  return sawGroup ? { alive: false } : { alive: true };
}

/**
 * Read process-group and state rows from the host's `ps`.
 * @param timeoutMs - Bounded time for the query.
 * @param signal - Aborts the query early.
 * @returns Plain `ps` output for conservative parsing.
 */
function readProcessGroups(timeoutMs: number, signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-A', '-o', 'pgid=,stat='],
      { timeout: timeoutMs, maxBuffer: MAX_PS_OUTPUT_BYTES, signal },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Forcefully terminate a Windows process and every process it started, in one
 * stage, with `taskkill /PID <pid> /T /F`. The result is checked: only a
 * successful run counts as delivered and only "process not found" as absent;
 * every other outcome rejects, so a failed stop is never mistaken for one that
 * reached the tree.
 * @param pid - PID of the root of the tree.
 * @param options - Bound for the `taskkill` run.
 * @returns `delivered` or `absent`; rejects on a POSIX host, and with a
 *   {@link WindowsTreeTerminationError} on any other `taskkill` outcome.
 */
export function terminateWindowsProcessTree(
  pid: number,
  options: WindowsTreeTerminationOptions,
): Promise<Exclude<SignalDelivery, 'denied'>> {
  assertChildPid(pid);
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Terminating a Windows process tree requires a Windows host'));
  }
  return new Promise((resolve, reject) => {
    execFile(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      { timeout: options.timeoutMs, windowsHide: true },
      (error) => {
        if (error === null) {
          resolve('delivered');
          return;
        }
        if (error.code === TASKKILL_PROCESS_NOT_FOUND) {
          resolve('absent');
          return;
        }
        // taskkill's own output names processes only; the outcome is reported by code.
        const failure = error.killed ? 'timed-out' : 'failed';
        reject(new WindowsTreeTerminationError(failure, String(error.code ?? error.signal), pid, error));
      },
    );
  });
}
