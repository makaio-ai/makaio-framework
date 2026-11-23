/**
 * Bounded stop of one spawned child: signal, escalate, observe, give up.
 *
 * On POSIX the default stop sends SIGTERM and then SIGKILL after the grace
 * period. A forceful-first site starts with SIGKILL. Both use a bounded exit wait.
 * On Windows each termination is forceful, so one stage precedes the wait. When
 * the wait expires without an observed exit, the stop reports the exit as
 * unobserved; it never invents one.
 *
 * The wait measures how the process answers the forceful stage, so it starts
 * only once that stage has been delivered. A POSIX signal is delivered
 * synchronously; a Windows tree termination is an asynchronous `taskkill` with
 * its own bound, and the wait starts when that run has finished. Until then
 * only the caller's deadline ends the stop.
 *
 * The termination is one operation per stop, and an end of the stop does not
 * cancel it: when the exit is observed first, the `taskkill` that is still
 * running keeps terminating the tree. {@link StopEscalation.termination} lets
 * the owner join it, so the end it reports does not precede the descendants'
 * termination.
 *
 * Signals go out only while the owner has not observed the exit. This is the
 * shared signalling rule of `process-tree.ts`: once the exit is observed the
 * stop ends, also under `process-group` ownership. Members of the group that
 * outlive the leader are not signalled again, and the owner's quiescence proof
 * reports whether any are left. A group ID is reserved only while the group
 * has a member, and a probe cannot prove that the group it found is still the
 * owner's when the next signal resolves the number, so a resistant member that
 * outlives the leader is reported, not stopped. Not observing the exit does
 * not strictly mean the child is unreaped (the runtime reaps before it
 * dispatches the exit callback); it is the last point at which the owner can
 * still count on addressing its own group.
 *
 * The injected signal port carries POSIX signals only. A Windows tree is ended
 * by `taskkill`, which does not go through the port.
 */
import { errorLabel, type ProcessTreeEvidence, type UnobservedExitReason } from './process-end.js';
import {
  signalOwnedProcesses,
  terminateWindowsProcessTree,
  WindowsTreeTerminationError,
  type ProcessSignalPort,
  type SignalDelivery,
  type StopOwnership,
  type WindowsTreeTerminationOptions,
} from './process-tree.js';

/**
 * The host facts a stop depends on, injectable so the Windows ordering can be
 * driven on a POSIX host; production code passes none and gets the real ones.
 */
export interface StopHost {
  /** Platform that selects the stages; defaults to `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Forceful termination of a Windows process tree; defaults to {@link terminateWindowsProcessTree}. */
  readonly terminateWindowsTree: (
    pid: number,
    options: WindowsTreeTerminationOptions,
  ) => Promise<Exclude<SignalDelivery, 'denied'>>;
}

/** Inputs to {@link startStopEscalation}. */
export interface StopEscalationOptions {
  /** PID of the spawned child. */
  readonly pid: number;
  /** Whether the child alone or its whole tree is stopped. */
  readonly ownership: StopOwnership;
  /** Time between the graceful and the forceful stage (POSIX only), in milliseconds. */
  readonly killGraceMs: number;
  /** Start with the forceful signal instead of the graceful stage. */
  readonly forcefulFirst?: boolean;
  /** Time the exit is awaited after the forceful stage, in milliseconds. */
  readonly exitObservationMs: number;
  /** Epoch milliseconds by which the stop must have reported; `undefined` for none. */
  readonly deadline: number | undefined;
  /** POSIX signal primitive; defaults to the host's `process.kill`. A Windows tree stop does not use it. */
  readonly port?: ProcessSignalPort;
  /** Platform and Windows termination; defaults to the real host. */
  readonly host?: StopHost;
  /** Whether the owner still has not observed the exit; read right before every signal. */
  readonly exitUnobserved: () => boolean;
  /** Called once when the observation window closed without an exit. */
  readonly onUnobserved: (reason: UnobservedExitReason) => void;
  /** Called with a short, content-free description of a signal that could not be sent. */
  readonly onSignalFailure: (description: string) => void;
}

/**
 * How a Windows tree termination ended.
 * `delivered` / `absent`: `taskkill` reached the tree, or nothing was left.
 * `refused`: `taskkill` failed.
 * `timed-out`: `taskkill` did not finish in its bound; nothing was refused.
 */
export type TreeTerminationOutcome = 'delivered' | 'absent' | 'refused' | 'timed-out';

/** Control of a running stop. */
export interface StopEscalation {
  /**
   * The Windows tree termination of this stop: settles once `taskkill` has
   * finished, also when the stop ended meanwhile. Never rejects. `undefined`
   * when the stop sends no such termination, as every POSIX stop does not: its
   * signals are delivered synchronously.
   */
  readonly termination: Promise<TreeTerminationOutcome> | undefined;
  /**
   * Bring the end of the stop forward; a later deadline changes nothing.
   * @param deadline - Epoch milliseconds by which the stop must have reported.
   */
  tighten(deadline: number): void;
  /** End the stop because the exit was observed; no further signal is sent. */
  cancel(): void;
}

/**
 * Stage of a running stop. `terminating` is the Windows tree termination in
 * flight: the forceful stage has been sent but not yet delivered, so no
 * observation window runs.
 */
type Stage = 'graceful' | 'terminating' | 'forceful' | 'done';

/**
 * Name a thrown value without reading its message.
 * @param error - Value thrown by a signal primitive.
 * @returns The errno code or error name, or the type of a non-error value.
 */
function failureLabel(error: unknown): string {
  return error instanceof Error ? errorLabel(error) : typeof error;
}

/** How a failed Windows tree termination counts for the stop. */
interface WindowsTerminationFailure {
  /** Whether the termination was refused, rather than merely not finished in time. */
  readonly refused: boolean;
  /** Content-free description for the signal-failure diagnostic. */
  readonly description: string;
}

/**
 * Classify a failed Windows tree termination. A `taskkill` that did not finish
 * in its bound refused nothing; every other failure counts as refused.
 * @param error - Rejection of the termination.
 * @returns Whether the termination was refused, and a content-free description.
 */
function classifyWindowsFailure(error: unknown): WindowsTerminationFailure {
  if (error instanceof WindowsTreeTerminationError && error.failure === 'timed-out') {
    return { refused: false, description: 'timed out (taskkill)' };
  }
  return { refused: true, description: `failed (${failureLabel(error)})` };
}

/** One running stop; see {@link startStopEscalation}. */
class Escalation implements StopEscalation {
  public readonly termination: Promise<TreeTerminationOutcome> | undefined;

  private readonly host: StopHost;
  private deadline: number;
  private stage: Stage = 'graceful';
  private stageStartedAt = Date.now();
  private refused = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Send the first stage and arm its timer.
   * @param options - Child, ownership, timings and callbacks of the stop.
   */
  public constructor(private readonly options: StopEscalationOptions) {
    this.host = options.host ?? { platform: process.platform, terminateWindowsTree: terminateWindowsProcessTree };
    this.deadline = options.deadline ?? Number.POSITIVE_INFINITY;
    if (this.host.platform === 'win32') {
      // Every Windows termination is forceful: one stage, then the bounded wait.
      if (options.ownership === 'process-group') {
        this.termination = this.terminateWindowsTree();
      } else {
        this.stage = 'forceful';
        this.send('SIGTERM');
      }
    } else if (options.forcefulFirst === true) {
      this.stage = 'forceful';
      this.send('SIGKILL');
    } else {
      this.send('SIGTERM');
    }
    this.arm();
  }

  public tighten(next: number): void {
    if (next >= this.deadline) return;
    this.deadline = next;
    this.arm();
  }

  public cancel(): void {
    this.stage = 'done';
    clearTimeout(this.timer);
  }

  /**
   * Record how one signal went; only a delivered or absent target counts as reached.
   * @param delivery - Checked result of the signal.
   */
  private note(delivery: SignalDelivery): void {
    if (delivery === 'denied') {
      this.refused = true;
      this.options.onSignalFailure('denied (EPERM)');
    }
  }

  /**
   * Send one POSIX signal while the exit is unobserved.
   * @param signal - Signal of the current stage.
   */
  private send(signal: NodeJS.Signals): void {
    const { ownership, pid, port, exitUnobserved, onSignalFailure } = this.options;
    if (!exitUnobserved()) return;
    try {
      this.note(signalOwnedProcesses(ownership, pid, signal, port));
    } catch (error) {
      this.refused = true;
      onSignalFailure(`failed (${failureLabel(error)})`);
    }
  }

  /**
   * Terminate the Windows tree in its single forceful stage. `taskkill` is
   * clamped to the observation time, to the stop deadline and to at least one
   * millisecond (`execFile` reads 0 as no bound at all); one that does not
   * finish in its bound refused nothing, so the stop then ends as an
   * observation timeout, not a denial. The observation of the exit starts when
   * the run has finished, delivered or failed alike, so a slow `taskkill`
   * never uses up the time the process is given to exit. A result that arrives
   * after the stop ended (the exit was observed meanwhile, or the deadline
   * gave up) changes nothing about the stop, but still settles the returned
   * outcome, which the owner joins.
   * @returns The outcome of the termination; never rejects.
   */
  private terminateWindowsTree(): Promise<TreeTerminationOutcome> {
    this.stage = 'terminating';
    const timeoutMs = Math.max(1, Math.min(this.options.exitObservationMs, this.deadline - Date.now()));
    // A throw before the run started is a failed termination like any other.
    return new Promise<Exclude<SignalDelivery, 'denied'>>((resolve) => {
      resolve(this.host.terminateWindowsTree(this.options.pid, { timeoutMs }));
    })
      .then(
        (delivery): TreeTerminationOutcome => {
          if (this.stage === 'terminating') this.note(delivery);
          return delivery;
        },
        (error: unknown): TreeTerminationOutcome => {
          const failure = classifyWindowsFailure(error);
          if (this.stage === 'terminating') {
            this.refused ||= failure.refused;
            this.options.onSignalFailure(failure.description);
          }
          return failure.refused ? 'refused' : 'timed-out';
        },
      )
      .then((outcome) => {
        this.observeForcefulStage();
        return outcome;
      });
  }

  /** Start the observation window of the forceful stage, unless the stop ended meanwhile. */
  private observeForcefulStage(): void {
    if (this.stage !== 'terminating') return;
    this.stage = 'forceful';
    this.stageStartedAt = Date.now();
    this.arm();
  }

  /**
   * When the current stage ends: the forceful stage keeps the observation
   * window inside the deadline, so a tight deadline shortens the grace first.
   * @returns Epoch milliseconds at which the current stage ends.
   */
  private stageEnd(): number {
    const { killGraceMs, exitObservationMs } = this.options;
    if (this.stage === 'graceful') {
      return Math.max(
        this.stageStartedAt,
        Math.min(this.stageStartedAt + killGraceMs, this.deadline - exitObservationMs),
      );
    }
    // A tree termination in flight is bounded by its own run; only a deadline can end it sooner.
    if (this.stage === 'terminating') return this.deadline;
    return Math.min(this.stageStartedAt + exitObservationMs, this.deadline);
  }

  /** (Re)arm the timer of the current stage; a stage without a bound arms none. */
  private arm(): void {
    clearTimeout(this.timer);
    if (this.stage === 'done') return;
    const end = this.stageEnd();
    if (!Number.isFinite(end)) return;
    this.timer = setTimeout(() => this.advance(), Math.max(0, end - Date.now()));
  }

  /** Move from the graceful to the forceful stage, or give up: observing it, or waiting for its delivery. */
  private advance(): void {
    if (this.stage === 'graceful') {
      this.stage = 'forceful';
      this.stageStartedAt = Date.now();
      this.send('SIGKILL');
      this.arm();
      return;
    }
    this.stage = 'done';
    if (this.options.exitUnobserved()) {
      this.options.onUnobserved(this.refused ? 'signal-denied' : 'observation-timeout');
    }
  }
}

/**
 * Start the bounded stop of a child that has not been observed to exit.
 * @param options - Child, ownership, timings and callbacks of the stop.
 * @returns Control to tighten or cancel the stop.
 */
export function startStopEscalation(options: StopEscalationOptions): StopEscalation {
  return new Escalation(options);
}

/**
 * Tree evidence for the end of a stop on Windows, after the tree termination
 * the stop started has finished.
 *
 * Windows has no process group to probe, so only a `taskkill` that succeeded for
 * the whole tree counts as proof (`quiescent`). No termination at all (an end
 * without a stop, such as a crash) or one that found no process to end
 * (`no-termination`), one that was refused or one that did not finish leaves
 * descendants that may still run, which is reported as such. The wait is bounded by `taskkill`'s own bound, and by the
 * abort signal an owner ties to its stop deadline.
 * @param termination - The stop's tree termination; `undefined` when none was started.
 * @param signal - Ends the wait early, with the termination counted as unfinished.
 * @returns Tree evidence for the end report.
 */
export async function windowsTreeEvidence(
  termination: Promise<TreeTerminationOutcome> | undefined,
  signal: AbortSignal,
): Promise<ProcessTreeEvidence> {
  if (termination === undefined) return { kind: 'unproven', reason: 'no-termination' };
  const aborted = new Promise<'timed-out'>((resolve) => {
    if (signal.aborted) resolve('timed-out');
    else signal.addEventListener('abort', () => resolve('timed-out'), { once: true });
  });
  switch (await Promise.race([termination, aborted])) {
    case 'refused':
      return { kind: 'unproven', reason: 'signal-error' };
    case 'timed-out':
      return { kind: 'unproven', reason: 'poll-timeout' };
    case 'delivered':
      return { kind: 'quiescent' };
    case 'absent':
      return { kind: 'unproven', reason: 'no-termination' };
  }
}
