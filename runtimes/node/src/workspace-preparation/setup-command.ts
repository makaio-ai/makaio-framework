import { spawn } from 'node:child_process';
import type { WorkspaceSetupCommand } from '@makaio/contracts';
import { proveProcessGroupQuiescence, signalOwnedProcesses, spawnOptionsForOwnership } from '@makaio/subprocess';
import type { GroupQuiescenceProof } from '@makaio/subprocess';

/**
 * Bounded fact about the Setup process group, recorded by the driver itself.
 * `exited`: no signal reached the group and its quiescence was proven.
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

/**
 * Result of one bounded setup command, once its leader closed and its process
 * group was observed. `stop-failed` means the group was not proven quiescent
 * (or the exit stayed unobserved), so the workspace is not safe to release. The
 * proof covers the process group only: it does not show that a descendant that
 * left the group stopped.
 */
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

/** Upper bound for proving the owned group quiescent after the command closed. */
const QUIESCENCE_PROOF_TIMEOUT_MS = 2_000;
/** Grace period between SIGTERM and SIGKILL when the command is stopped. */
const STOP_ESCALATION_MS = 200;
/** Upper bound for observing the command's exit after its SIGKILL. */
const EXIT_OBSERVATION_MS = 2_000;

/**
 * Observe whether the owned group went quiet after the leader's close. Nothing
 * is signalled here: once the leader's exit is observed the group gets no
 * further signal (the shared rule in `process-tree.ts` of `@makaio/subprocess`).
 * A group ID is reserved only while the group has a member, and a probe cannot
 * prove that the group it found is still this command's when a signal resolves
 * the number again, so a member that outlives the leader is reported through the
 * proof and never killed. The proof covers the process group only: a descendant
 * that left it (`setsid`, `setpgid`) is neither signalled nor counted, so it
 * says nothing about whether such a descendant stopped.
 * @param pid - Spawned group leader, absent when process creation failed.
 * @returns The bounded quiescence proof of the group.
 */
async function observeGroupQuiescence(pid: number | undefined): Promise<GroupQuiescenceProof> {
  if (pid === undefined) return { kind: 'quiescent' };
  return proveProcessGroupQuiescence(pid, { timeoutMs: QUIESCENCE_PROOF_TIMEOUT_MS });
}

/**
 * Build an honest, bounded process-group observation from driver-recorded facts.
 * @param pid - Spawned group leader PID.
 * @param signalDelivered - Whether a stop signal reached the group during the stop phase
 *   (SIGTERM or escalation SIGKILL via `stop()`). The proof after the close signals nothing.
 * @param proof - Quiescence proof observed after the leader's close.
 * @returns Typed observation: `exited` or `signalled-and-quiesced` when quiescence is
 *   proven; `signalled-unconfirmed` when the group was signalled but quiescence is not;
 *   `unsignalled-unconfirmed` when no signal reached the group and quiescence is also
 *   unproven — the group state is entirely unknown.
 */
function buildProcessGroupObservation(
  pid: number,
  signalDelivered: boolean,
  proof: GroupQuiescenceProof,
): SetupProcessGroupObservation {
  const observedAt = new Date();
  if (proof.kind === 'quiescent') {
    return signalDelivered
      ? { pid, outcome: 'signalled-and-quiesced', observedAt }
      : { pid, outcome: 'exited', observedAt };
  }
  // When no stop-phase signal reached a live group, we cannot claim the group
  // was ever signalled — use the distinct unsignalled-unconfirmed outcome
  // instead of signalled-unconfirmed.
  return {
    pid,
    outcome: signalDelivered ? 'signalled-unconfirmed' : 'unsignalled-unconfirmed',
    cause: proof.reason,
    observedAt,
  };
}

/**
 * Execute a bounded command directly, without shell parsing or a new command policy.
 * POSIX process groups own ordinary descendants. Windows is rejected before spawn:
 * safe release needs a quiescence proof of the owned group, and that proof is POSIX-only.
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
 *
 * Every phase is bounded: a stop sends `SIGTERM`, then `SIGKILL` after
 * {@link STOP_ESCALATION_MS}, then waits at most {@link EXIT_OBSERVATION_MS} for
 * the exit. A stop whose exit stays unobserved (signals denied or failed, or a
 * process that does not die) settles as `stop-failed` with the group evidence
 * gathered at that point, and the child no longer keeps the host alive.
 *
 * After the leader's close nothing is signalled: the driver only observes
 * whether the group went quiet (see {@link observeGroupQuiescence}), and a group
 * that did not settles as `stop-failed`, also for a command that completed.
 * @param options - Command and runtime-local inputs.
 * @returns Result once the leader closed and the group was observed quiescent,
 *   or once the stop gave up observing them.
 */
function executeSetupCommand(options: SetupCommandOptions): Promise<SetupCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(options.recipe.command, options.recipe.args, {
      cwd: options.workspaceRoot,
      env: { ...process.env, ...options.recipe.env, ...options.env },
      shell: false,
      ...spawnOptionsForOwnership('process-group'),
      // Avoid retaining unbounded output or accidentally persisting credential-bearing logs.
      stdio: 'ignore',
    });
    let status: SetupCommandResult['status'] | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let observation: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    // A terminal status is no signal evidence: a group that exited between the
    // leader's exit and its close event answers ESRCH, and a denied signal
    // delivers nothing either. Only a signal that reached an existing group counts.
    let signalDelivered = false;
    /**
     * Signal the owned group during the stop phase and record delivery.
     * A denied signal (EPERM) is inconclusive throughout termination, not just
     * at close: escalation and the final quiescence proof stay responsible for safety.
     * @param pid - Spawned group leader.
     * @param signal - Stop-phase signal.
     * @returns False when the signal failed with an unexpected error.
     */
    const signalStopPhase = (pid: number, signal: NodeJS.Signals): boolean => {
      try {
        if (signalOwnedProcesses('process-group', pid, signal) === 'delivered') signalDelivered = true;
        return true;
      } catch {
        return false;
      }
    };
    /**
     * End the invocation once: clear every timer and listener, observe the
     * group's quiescence, and resolve. The delivery flag is final from here on.
     * @param exitCode - Observed exit code, `null` for a signal or an unobserved exit.
     * @param exitUnobserved - Whether the stop gave up observing the exit.
     */
    const settle = (exitCode: number | null, exitUnobserved: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(escalation);
      clearTimeout(observation);
      options.signal?.removeEventListener('abort', abort);
      // A child whose exit was not observed may run on; it must not keep the
      // host alive, while its late `close` still finds the settled invocation.
      if (exitUnobserved) child.unref();
      void observeGroupQuiescence(child.pid).then((proof) => {
        const finalStatus =
          proof.kind === 'quiescent' && !exitUnobserved
            ? (status ?? (exitCode === 0 ? 'completed' : 'failed'))
            : 'stop-failed';
        const processGroup =
          child.pid !== undefined ? buildProcessGroupObservation(child.pid, signalDelivered, proof) : undefined;
        resolve({ status: finalStatus, exitCode, processGroup });
      });
    };
    const stop = (reason: 'cancelled' | 'timed-out'): void => {
      if (status !== undefined) return;
      status = reason;
      const pid = child.pid;
      if (pid === undefined) return;
      // A failed signal does not end the stop: the next stage still runs, and
      // the observation bound settles a child that none of them reached.
      if (!signalStopPhase(pid, 'SIGTERM')) status = 'stop-failed';
      escalation = setTimeout(() => {
        if (!signalStopPhase(pid, 'SIGKILL')) status = 'stop-failed';
        observation = setTimeout(() => settle(null, true), EXIT_OBSERVATION_MS);
      }, STOP_ESCALATION_MS);
    };
    const abort = (): void => stop('cancelled');
    const timeout = setTimeout(() => stop('timed-out'), options.recipe.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once('error', () => {
      status = 'spawn-failed';
    });
    child.once('close', (exitCode) => settle(exitCode, false));
  });
}
