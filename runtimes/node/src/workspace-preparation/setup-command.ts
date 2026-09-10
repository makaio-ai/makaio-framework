import { execFile, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { WorkspaceSetupCommand } from '@makaio/contracts';

/**
 * Bounded fact about the Setup process group, recorded by the driver itself.
 * `exited`: the group closed on its own and quiescence of the whole group was proven.
 * `signalled-and-quiesced`: the driver signalled the group and proved it quiescent afterwards.
 * `signalled-unconfirmed`: the driver signalled the group but could not prove quiescence
 *   (poll timed out, `ps` unavailable, or a signal failed) — never treat as a stop proof.
 * `unsignalled-unconfirmed`: no signal reached the group (all attempts were absent or EPERM)
 *   and quiescence could not be proven either — the group state is entirely unknown.
 *
 * The driver records raw values only. Rendering a human-readable summary and
 * formatting the instant belong to whoever reports the fact, not to the driver:
 * one fact can be reported to several boundaries with different wording.
 */
export type SetupProcessGroupObservation = {
  readonly pid: number;
  readonly outcome: 'exited' | 'signalled-and-quiesced' | 'signalled-unconfirmed' | 'unsignalled-unconfirmed';
  /** Why quiescence stayed unproven; absent whenever the outcome proves quiescence. */
  readonly cause?: 'poll-timeout' | 'ps-unavailable' | 'signal-error';
  /** Instant the driver recorded this outcome. */
  readonly observedAt: Date;
};

/** Result of one bounded setup command, after its owned process group has stopped. */
export interface SetupCommandResult {
  readonly status: 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'spawn-failed' | 'stop-failed';
  readonly exitCode: number | null;
  /** Generic diagnostics deliberately exclude command arguments and environment values. */
  readonly message?: string;
  /** Process-group observation, present exactly when a process was spawned. */
  readonly processGroup?: SetupProcessGroupObservation;
}

/** Local inputs to an already-authorized command; this helper grants no permissions. */
export interface SetupCommandOptions {
  readonly recipe: WorkspaceSetupCommand;
  readonly workspaceRoot: string;
  readonly signal?: AbortSignal;
  /** Host-injected environment, including credentials when needed. Never persisted. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Keep command deadlines within Node's timer range without overflow or truncation.
 * @param timeoutMs - Requested command timeout in milliseconds.
 * @returns Whether the timeout can be scheduled without timer coercion.
 */
export function isValidSetupCommandTimeoutMs(timeoutMs: number): boolean {
  return Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 2_147_483_647;
}

/**
 * Tagged observation of group liveness after a kill(group,0) + ps probe.
 * `psMissing` is set only when the host has no `ps` executable at all, which
 * is the one failure no later probe in the same poll can recover from.
 */
type GroupLivenessResult = { readonly alive: false } | { readonly alive: true; readonly psMissing?: true };

/**
 * Tagged conclusion from the final owned-group cleanup pass.
 * `signalledLiveGroup` records that the cleanup signal reached a group that
 * still existed, which is a signalled stop even when the leader had exited.
 * Present in both branches so the caller can determine whether any signal
 * reached the group even when quiescence could not be proven.
 */
type StopGroupResult =
  | { readonly quiesced: true; readonly signalledLiveGroup: boolean }
  | {
      readonly quiesced: false;
      readonly cause: 'poll-timeout' | 'ps-unavailable' | 'signal-error';
      readonly signalledLiveGroup: boolean;
    };

/** Whether a group signal reached an existing group or found nothing left (ESRCH). */
type GroupSignalResult = 'signalled' | 'absent';

/**
 * Signal the ordinary owned process group, tolerating an already-exited group.
 * @param pid - Leader of the setup process group.
 * @param signal - Signal delivered to the whole group.
 * @returns Whether the group still existed when the signal was delivered.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): GroupSignalResult {
  try {
    process.kill(-pid, signal);
    return 'signalled';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return 'absent';
  }
}

/**
 * Decide whether a failed `ps` query proves the host has no usable `ps` at all.
 *
 * A missing executable is permanent; a timeout, a transient launch failure or
 * unparseable output is not, and `ps` is the only probe that distinguishes a
 * zombie-only group from a live descendant. Latching on a recoverable failure
 * would turn a quiescent group into `stop-failed`.
 * @param error - Rejection reported by the host `ps` query.
 * @returns True when no later query in this poll can succeed either.
 */
function isPsMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Check liveness separately from PID existence: unreaped zombies cannot execute
 * or write files, but still make kill(group, 0) succeed until their parent reaps them.
 * @param pid - Owned process group leader.
 * @param psTimeoutMs - Remaining bounded time available for the ps query.
 * @param psMissing - Whether an earlier probe in this poll proved ps permanently absent.
 * @returns Tagged group liveness, noting a permanently missing ps for the caller.
 */
async function groupHasLiveProcesses(
  pid: number,
  psTimeoutMs: number,
  psMissing: boolean,
): Promise<GroupLivenessResult> {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { alive: false };
    // Darwin can report EPERM for a zombie-only group. It proves neither
    // liveness nor quiescence; require the same positive ps evidence below.
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
  // A host without a ps executable does not grow one mid-poll, so spend the
  // remaining budget on the cheap group probe instead of the same failure.
  if (psMissing) return { alive: true };
  let stdout: string;
  try {
    stdout = await readProcessGroups(psTimeoutMs);
  } catch (error) {
    // Unlike a naive kill-only check, a successful group probe does not prove
    // quiescence: it may name a live descendant or an unreaped zombie. Without
    // ps evidence, wait conservatively for ESRCH instead. Only a missing ps
    // latches; a timed-out or transiently failing query is retried on the next
    // tick, inside the same bounded deadline.
    return isPsMissing(error) ? { alive: true, psMissing: true } : { alive: true };
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
  // sawGroup=true: all matching processes are zombies → quiescent.
  // sawGroup=false: group not found in ps but kill(group,0) did not return ESRCH → conservative.
  return sawGroup ? { alive: false } : { alive: true };
}

/**
 * Read process-group and state rows using the host's ps implementation.
 * @param timeoutMs - Remaining bounded time for the host query.
 * @returns Plain ps output for conservative process-state parsing.
 */
function readProcessGroups(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-A', '-o', 'pgid=,stat='], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Stop remaining descendants and confirm no live process remains in the owned group.
 * @param pid - Spawned group leader, absent when process creation failed.
 * @returns Tagged quiescence conclusion, with the cause when quiescence is unproven.
 */
async function stopRemainingGroup(pid: number | undefined): Promise<StopGroupResult> {
  if (pid === undefined) return { quiesced: true, signalledLiveGroup: false };
  let signalledLiveGroup = false;
  try {
    try {
      signalledLiveGroup = signalGroup(pid, 'SIGKILL') === 'signalled';
    } catch (error) {
      // XNU excludes zombies from group signalling, so final cleanup can
      // return EPERM after termination. Only the bounded proof below may
      // establish safe release; a denied signal alone never does, and it
      // proves no live group either — it stays out of `signalledLiveGroup`.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    const deadline = Date.now() + 2_000;
    let psMissing = false;
    while (Date.now() < deadline) {
      // The deadline can pass between the loop condition and this read; a
      // non-positive budget would become an unbounded execFile timeout.
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const liveness = await groupHasLiveProcesses(pid, Math.min(1_000, remaining), psMissing);
      if (!liveness.alive) return { quiesced: true, signalledLiveGroup };
      psMissing = psMissing || liveness.psMissing === true;
      await delay(20);
    }
    // Only a permanently missing ps is reported as `ps-unavailable`; a poll that
    // ended with recoverable failures simply ran out of time.
    return { quiesced: false, cause: psMissing ? 'ps-unavailable' : 'poll-timeout', signalledLiveGroup };
  } catch {
    // Do not claim safe release when the host cannot stop the process group.
    return { quiesced: false, cause: 'signal-error', signalledLiveGroup };
  }
}

/**
 * Build an honest, bounded process-group observation from driver-recorded facts.
 * @param pid - Spawned group leader PID.
 * @param signalDelivered - Whether a stop signal reached the group during the stop phase
 *   (SIGTERM or escalation SIGKILL via `stop()`); does not include the cleanup SIGKILL.
 * @param stopResult - Tagged quiescence conclusion from the final cleanup pass, carrying
 *   whether the cleanup SIGKILL itself reached a live group.
 * @returns Typed observation: `exited` or `signalled-and-quiesced` when quiescence is
 *   proven; `signalled-unconfirmed` when the group was signalled but quiescence is not;
 *   `unsignalled-unconfirmed` when no signal reached the group and quiescence is also
 *   unproven — the group state is entirely unknown.
 */
function buildProcessGroupObservation(
  pid: number,
  signalDelivered: boolean,
  stopResult: StopGroupResult,
): SetupProcessGroupObservation {
  const observedAt = new Date();
  if (stopResult.quiesced) {
    // A cleanup signal that reached an existing group killed a surviving
    // descendant, so the group did not simply exit — even if the leader did.
    return signalDelivered || stopResult.signalledLiveGroup
      ? { pid, outcome: 'signalled-and-quiesced', observedAt }
      : { pid, outcome: 'exited', observedAt };
  }
  // When neither the stop-phase signals nor the cleanup SIGKILL reached any
  // live group, we cannot claim the group was ever signalled — use the
  // distinct unsignalled-unconfirmed outcome instead of signalled-unconfirmed.
  const anySig = signalDelivered || stopResult.signalledLiveGroup;
  return {
    pid,
    outcome: anySig ? 'signalled-unconfirmed' : 'unsignalled-unconfirmed',
    cause: stopResult.cause,
    observedAt,
  };
}

/**
 * Execute a bounded command directly, without shell parsing or a new command policy.
 * POSIX process groups own ordinary descendants; Windows is rejected before spawn
 * until an equivalent tree-lifecycle implementation is supplied.
 * @param options - Frozen recipe and local execution context.
 * @returns Classified exit result; `stop-failed` explicitly forbids safe release.
 */
export async function runSetupCommand(options: SetupCommandOptions): Promise<SetupCommandResult> {
  if (options.signal?.aborted) return { status: 'cancelled', exitCode: null };
  if (!isValidSetupCommandTimeoutMs(options.recipe.timeoutMs)) {
    return {
      status: 'spawn-failed',
      exitCode: null,
      message: 'Setup timeout must be an integer between 1 and 2147483647 milliseconds',
    };
  }
  if (process.platform === 'win32') {
    return { status: 'spawn-failed', exitCode: null, message: 'Setup process groups require a POSIX host' };
  }
  try {
    return await executeSetupCommand(options);
  } catch {
    return { status: 'spawn-failed', exitCode: null, message: 'Could not start the setup command' };
  }
}

/**
 * Own timers, cancellation listeners and process completion for one invocation.
 * @param options - Command and runtime-local inputs.
 * @returns Result only after the process and remaining owned descendants stop.
 */
function executeSetupCommand(options: SetupCommandOptions): Promise<SetupCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(options.recipe.command, options.recipe.args, {
      cwd: options.workspaceRoot,
      env: { ...process.env, ...options.recipe.env, ...options.env },
      shell: false,
      detached: true,
      // Avoid retaining unbounded output or accidentally persisting credential-bearing logs.
      stdio: 'ignore',
    });
    let status: SetupCommandResult['status'] | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    // A terminal status is no signal evidence: a group that exited between the
    // leader's exit and its close event answers ESRCH, and a denied signal
    // delivers nothing either. Only a signal that reached an existing group
    // counts, exactly as `signalledLiveGroup` counts the cleanup signal.
    let signalDelivered = false;
    const stop = (reason: 'cancelled' | 'timed-out'): void => {
      if (status !== undefined) return;
      status = reason;
      if (child.pid === undefined) return;
      try {
        if (signalGroup(child.pid, 'SIGTERM') === 'signalled') signalDelivered = true;
      } catch (error) {
        // EPERM is inconclusive throughout termination, not just at close.
        // Keep escalation and the final quiescence proof responsible for safety.
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
          status = 'stop-failed';
          return;
        }
      }
      escalation = setTimeout(() => {
        try {
          if (child.pid !== undefined && signalGroup(child.pid, 'SIGKILL') === 'signalled') signalDelivered = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EPERM') status = 'stop-failed';
        }
      }, 200);
    };
    const abort = (): void => stop('cancelled');
    const timeout = setTimeout(() => stop('timed-out'), options.recipe.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once('error', () => {
      status = 'spawn-failed';
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      options.signal?.removeEventListener('abort', abort);
      // The escalation timer is cleared above, so no further signal can be
      // delivered and the delivery flag is final from here on.
      void stopRemainingGroup(child.pid).then((stopResult) => {
        const finalStatus = stopResult.quiesced ? (status ?? (exitCode === 0 ? 'completed' : 'failed')) : 'stop-failed';
        const processGroup =
          child.pid !== undefined ? buildProcessGroupObservation(child.pid, signalDelivered, stopResult) : undefined;
        resolve({ status: finalStatus, exitCode, processGroup });
      });
    });
  });
}
