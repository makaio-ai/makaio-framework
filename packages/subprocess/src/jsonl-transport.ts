import { spawn, type ChildProcess } from 'node:child_process';
import type {
  IJsonlTransport,
  JsonlTransportOptions,
  MessageListener,
  TransportCloseOptions,
  TransportStatus,
} from './types.js';
import {
  createJsonlDecoder,
  describeJsonlDrops,
  type JsonlDecodeBatch,
  type JsonlDecodeEnd,
  type JsonlDecoder,
} from './jsonl-framing.js';
import { notifyListeners } from './notify-listeners.js';
import {
  deriveEndCause,
  errorLabel,
  type CommunicationFailure,
  type DrainOutcome,
  type EndFact,
  type ObservedProcessExit,
  type ProcessExit,
  type ProcessTreeEvidence,
  type TransportEnd,
  type UnobservedExitReason,
} from './process-end.js';
import {
  proveProcessGroupQuiescence,
  spawnOptionsForOwnership,
  type ProcessSignalPort,
  type StopOwnership,
} from './process-tree.js';
import { nonNegativeOption } from './option-values.js';
import { startStopEscalation, windowsTreeEvidence, type StopEscalation, type StopHost } from './stop-escalation.js';

/**
 * Default drain window. Conservative: a final response a descendant writes
 * shortly after the child exited is still delivered; only a stalled or
 * inherited pipe ever waits this long.
 */
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
/** Default time between `SIGTERM` and `SIGKILL`. */
const DEFAULT_KILL_GRACE_MS = 5_000;
/** Default wait for the exit after the forceful stage. */
const DEFAULT_EXIT_OBSERVATION_MS = 2_000;

/**
 * How far stdout got. Only `open` still decodes: `ended` reached the genuine
 * end, `failed` reported an error, `abandoned` was cut off when the end was reported.
 */
type StdoutState =
  | { readonly kind: 'open' }
  | { readonly kind: 'ended' | 'failed' | 'abandoned'; readonly discardedChars: number };

/**
 * What made the transport report its end.
 * `closed`: every stdio pipe closed after the exit.
 * `drain-deadline`: the drain window closed first.
 * `unobserved`: the stop gave up observing the exit; no drain window opened.
 */
type EndTrigger = 'closed' | 'drain-deadline' | 'unobserved';

/**
 * Turn whatever a listener threw into an error without reading its content.
 * @param thrown - Value a listener threw.
 * @returns The error itself, or a content-free stand-in.
 */
function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(`message listener threw a non-error value (${typeof thrown})`);
}

/**
 * The one owner of a JSONL child: spawn, pipes, framing, drain, the three end
 * facts and the end report. See {@link IJsonlTransport} for the contract.
 */
class JsonlTransport implements IJsonlTransport {
  private readonly endReport = Promise.withResolvers<TransportEnd>();
  private readonly exitObservation = Promise.withResolvers<ObservedProcessExit>();

  private readonly child: ChildProcess;
  private readonly name: string;
  private readonly ownership: StopOwnership;
  private readonly decoder: JsonlDecoder;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly drainTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly exitObservationMs: number;
  /** Signal primitive; `undefined` selects the host's `process.kill`. */
  private readonly signalPort: ProcessSignalPort | undefined;
  /** Platform and Windows tree termination; `undefined` selects the real host. */
  private readonly stopHost: StopHost | undefined;

  /** The three facts, in observation order; each kind counts at its first occurrence only. */
  private readonly facts: EndFact[] = [];
  private processExit: ProcessExit | undefined;
  private communicationFailure: CommunicationFailure | undefined;
  private stdout: StdoutState = { kind: 'open' };
  private childClosed = false;
  private writable = true;
  private state: TransportStatus = 'writable';
  private endDecided = false;

  private stopDeadline: number | undefined;
  private escalation: StopEscalation | undefined;
  /** When the drain window closes; set once an exit is observed. */
  private drainEndsAt: number | undefined;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private stdoutEndTimer: ReturnType<typeof setTimeout> | undefined;
  /** The pending quiescence proof, until the end report is out; a tighter deadline ends it early. */
  private treeProof: { readonly abort: AbortController; readonly endsAt: number } | undefined;
  private treeProofTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Spawn the child and wire its events.
   * @param options - Spawn, policy and timing options.
   */
  public constructor(private readonly options: JsonlTransportOptions) {
    const { command, args = [], cwd, env, processName = command } = options;
    this.name = processName;
    this.drainTimeoutMs = nonNegativeOption('drainTimeoutMs', options.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS);
    this.killGraceMs = nonNegativeOption('killGraceMs', options.killGraceMs, DEFAULT_KILL_GRACE_MS);
    this.exitObservationMs = nonNegativeOption(
      'exitObservationMs',
      options.exitObservationMs,
      DEFAULT_EXIT_OBSERVATION_MS,
    );
    this.signalPort = options.signalPort;
    this.stopHost = options.stopHost;
    this.ownership = options.terminateTree === false ? 'direct-child' : 'process-group';
    this.decoder = createJsonlDecoder({
      finalLine: options.finalLine ?? 'discard',
      maxLineLength: options.maxLineLength,
    });

    const cleanEnv = Object.fromEntries(
      Object.entries(env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    this.child = spawn(command, [...args], {
      cwd,
      env: options.envMode === 'replace' ? cleanEnv : { ...process.env, ...cleanEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...spawnOptionsForOwnership(this.ownership),
    });
    this.wireChild();
    this.wireStreams();
  }

  public get ended(): Promise<TransportEnd> {
    return this.endReport.promise;
  }

  public get exitObserved(): Promise<ObservedProcessExit> {
    return this.exitObservation.promise;
  }

  public get status(): TransportStatus {
    return this.state;
  }

  public send(message: object): void {
    if (!this.writable) throw new Error(`${this.name} transport is not writable (${this.state})`);
    this.child.stdin?.write(JSON.stringify(message) + '\n');
  }

  public close(options?: TransportCloseOptions): Promise<TransportEnd> {
    // A deadline binds every phase still pending, including the evidence an
    // already decided end is waiting for.
    if (options?.deadline !== undefined && this.state !== 'ended') this.applyDeadline(options.deadline);
    if (this.endDecided) return this.ended;
    if (!this.facts.some((fact) => fact.kind === 'stop-requested')) this.facts.push({ kind: 'stop-requested' });
    this.beginStop();
    return this.ended;
  }

  public onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Facts
  // -------------------------------------------------------------------------

  /** Wire the child's process events. */
  private wireChild(): void {
    // Node emits `error` before the spawn when the child could not be started
    // (then `close`, never `exit`). After the spawn it emits `error` only for
    // its own `kill()` and IPC, which this transport never uses; such an error
    // is a diagnostic and ends nothing.
    this.child.on('error', (error: Error) => {
      if (this.child.pid === undefined) {
        this.exitObservation.resolve({ kind: 'spawn-failed', error });
        this.recordProcessExit({ kind: 'spawn-failed', error });
        return;
      }
      console.warn(`[${this.name}] child process reported an error after the spawn (${errorLabel(error)})`);
    });

    this.child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // A real exit is always reported here, also long after an end that
      // recorded the exit as unobserved; the recorded fact never changes.
      this.exitObservation.resolve({ kind: 'exited', code, signal });
      this.recordProcessExit({ kind: 'exited', code, signal });
    });

    // `close` follows the exit once every stdio pipe has closed, so it completes
    // the drain. Bun emits it for a failed spawn before (and without) a stdout
    // `end`; a child that never started has nothing to drain, see `settleDrain`.
    this.child.on('close', () => {
      this.childClosed = true;
      this.maybeReportEnd();
    });
  }

  /** Wire stdin, stdout and stderr. */
  private wireStreams(): void {
    const { stdin, stdout, stderr } = this.child;

    stdin?.on('error', (error: Error) => this.failCommunication({ kind: 'stdin-failed', error }));

    stdout?.on('data', (chunk: Buffer) => {
      if (this.stdout.kind === 'open') this.deliver(this.decoder.push(chunk));
    });
    stdout?.on('end', () => {
      if (this.stdout.kind !== 'open') return;
      // The genuine end of stdout: only here may a final line be parsed.
      const end = this.decoder.end();
      this.stdout = { kind: 'ended', discardedChars: end.discardedChars };
      this.deliver(end);
      this.awaitExitAfterStdoutEnd();
    });
    stdout?.on('error', (error: Error) => {
      if (this.stdout.kind !== 'open') return;
      this.stdout = { kind: 'failed', discardedChars: this.decoder.abandon() };
      this.failCommunication({ kind: 'stdout-failed', error });
    });

    let stderrSuppressed = false;
    stderr?.on('data', (chunk: Buffer) => {
      if (this.options.stderr !== 'suppress') {
        console.warn(`[${this.name}]`, chunk.toString('utf-8'));
        return;
      }
      if (stderrSuppressed) return;
      stderrSuppressed = true;
      console.warn(`[${this.name}] stderr output suppressed`);
    });
    stderr?.on('error', (error: Error) => console.warn(`[${this.name}] stderr failed (${errorLabel(error)})`));
  }

  /**
   * Record how the child ended, once. Blocks writing and opens the drain window.
   * @param exit - Exit, failed spawn or unobserved end.
   */
  private recordProcessExit(exit: ProcessExit): void {
    if (this.processExit !== undefined || this.endDecided) return;
    this.processExit = exit;
    this.facts.push({ kind: 'process-ended', exit });
    this.blockWrites();
    // The stop ends with the observed exit, also for an owned process group:
    // after it no group signal goes out (the rule in `process-tree.ts`), and
    // the quiescence proof before the end report says whether any member
    // outlived the leader. The end report carries both facts separately. Such
    // members are reported as `tree: unproven`, and the lifecycle withholds a
    // restart for them, rather than being stopped.
    this.escalation?.cancel();
    clearTimeout(this.stdoutEndTimer);
    if (exit.kind === 'unobserved') {
      this.reportEnd('unobserved');
      return;
    }
    this.drainEndsAt = Date.now() + this.drainTimeoutMs;
    this.armDrainTimer();
    this.maybeReportEnd();
  }

  /**
   * Record the first failure of the channel and stop the child.
   * @param failure - What failed.
   */
  private failCommunication(failure: CommunicationFailure): void {
    if (this.communicationFailure !== undefined || this.endDecided) return;
    this.communicationFailure = failure;
    this.facts.push({ kind: 'communication-failed', failure });
    this.beginStop();
  }

  /**
   * Deliver the messages of one decode step and log what it dropped. A
   * dropped line names no request and leaves the child running, so it is a
   * diagnostic, not a failure.
   * @param batch - Decoded messages and drop counts of a chunk or of the end.
   */
  private deliver(batch: JsonlDecodeBatch | JsonlDecodeEnd): void {
    for (const message of batch.messages) {
      notifyListeners(this.messageListeners, message, (thrown) => {
        if (this.options.listenerErrors === 'fail') {
          this.failCommunication({ kind: 'listener-failed', error: asError(thrown) });
          return;
        }
        console.error(`[${this.name}] transport listener threw`, thrown);
      });
    }
    const drops = describeJsonlDrops(batch);
    if (drops !== undefined) console.warn(`[${this.name}] dropped ${drops} from stdout`);
  }

  // -------------------------------------------------------------------------
  // Stop and deadlines
  // -------------------------------------------------------------------------

  /** Block writing; the end is now under way. */
  private blockWrites(): void {
    this.writable = false;
    if (this.state === 'writable') this.state = 'ending';
  }

  /** Stop the child while its exit is unobserved; idempotent. */
  private beginStop(): void {
    this.blockWrites();
    const pid = this.child.pid;
    // Without a PID the spawn failed; its `error` and `close` are already queued.
    if (this.escalation !== undefined || this.processExit !== undefined || pid === undefined) return;
    clearTimeout(this.stdoutEndTimer);
    this.escalation = startStopEscalation({
      pid,
      ownership: this.ownership,
      killGraceMs: this.killGraceMs,
      exitObservationMs: this.exitObservationMs,
      deadline: this.stopDeadline,
      port: this.signalPort,
      host: this.stopHost,
      exitUnobserved: () => this.processExit === undefined,
      onUnobserved: (reason: UnobservedExitReason) => this.recordProcessExit({ kind: 'unobserved', reason }),
      onSignalFailure: (description) => console.warn(`[${this.name}] stop signal ${description}`),
    });
  }

  /**
   * Shorten every pending phase to a caller's deadline.
   * @param deadline - Epoch milliseconds by which the end must be reported.
   */
  private applyDeadline(deadline: number): void {
    if (this.stopDeadline !== undefined && this.stopDeadline <= deadline) return;
    this.stopDeadline = deadline;
    this.escalation?.tighten(deadline);
    if (this.drainEndsAt !== undefined) this.armDrainTimer();
    this.armTreeProofTimer();
    // A pending wait for the exit after stdout ended needs no tightening: the
    // stop that follows every close() cancels it.
  }

  /**
   * End of a window, shortened to the stop deadline.
   * @param windowEndsAt - Epoch milliseconds at which the window closes on its own.
   * @returns The earlier of the window end and the stop deadline.
   */
  private clamp(windowEndsAt: number): number {
    return Math.min(windowEndsAt, this.stopDeadline ?? Number.POSITIVE_INFINITY);
  }

  /** (Re)arm the drain timer; the end is reported when it fires. */
  private armDrainTimer(): void {
    clearTimeout(this.drainTimer);
    if (this.drainEndsAt === undefined || this.endDecided) return;
    this.drainTimer = setTimeout(
      () => this.reportEnd('drain-deadline'),
      Math.max(0, this.clamp(this.drainEndsAt) - Date.now()),
    );
  }

  /** On a `terminal` channel, wait a bounded time for the exit once stdout ended. */
  private awaitExitAfterStdoutEnd(): void {
    if (this.options.onStdoutEnd !== 'terminal' || this.processExit !== undefined || this.escalation !== undefined) {
      return;
    }
    this.stdoutEndTimer = setTimeout(
      () => this.failCommunication({ kind: 'stdout-ended' }),
      Math.max(0, this.clamp(Date.now() + this.drainTimeoutMs) - Date.now()),
    );
  }

  // -------------------------------------------------------------------------
  // End report
  // -------------------------------------------------------------------------

  /** Report the end once the exit is known and every stdio pipe has closed. */
  private maybeReportEnd(): void {
    if (this.processExit !== undefined && this.childClosed) this.reportEnd('closed');
  }

  /**
   * Decide the end exactly once, release every resource, then report it.
   * @param trigger - What made the end due.
   */
  private reportEnd(trigger: EndTrigger): void {
    if (this.endDecided || this.processExit === undefined) return;
    this.endDecided = true;
    this.blockWrites();
    clearTimeout(this.drainTimer);
    clearTimeout(this.stdoutEndTimer);
    this.escalation?.cancel();

    const exit = this.processExit;
    const cause = deriveEndCause(this.facts);
    const drain = this.settleDrain(trigger, exit);
    const communicationFailure = this.communicationFailure;
    this.release();

    void this.treeEvidence().then((tree) => {
      this.state = 'ended';
      this.endReport.resolve({ cause, exit, drain, communicationFailure, tree });
    });
  }

  /**
   * Close the drain: whatever stdout has not delivered by now is dropped, and
   * the outcome names what cut it short.
   * @param trigger - What made the end due.
   * @param exit - The recorded process exit.
   * @returns How far stdout was delivered, and whether a pipe was still held.
   */
  private settleDrain(trigger: EndTrigger, exit: ProcessExit): DrainOutcome {
    if (this.stdout.kind === 'open') this.stdout = { kind: 'abandoned', discardedChars: this.decoder.abandon() };
    const { discardedChars } = this.stdout;
    // A child that never started produced no output, whatever order its
    // runtime reports the pipes closing in.
    if (exit.kind === 'spawn-failed') return { kind: 'complete', discardedChars };
    switch (this.stdout.kind) {
      case 'failed':
        return { kind: 'failed', discardedChars };
      case 'ended':
        // stdout is delivered; only a deadline that found another pipe held
        // makes the drain incomplete.
        return trigger === 'drain-deadline'
          ? { kind: 'timed-out', discardedChars, stdoutComplete: true }
          : { kind: 'complete', discardedChars };
      case 'abandoned':
        // For a child that started, `close` always follows stdout's own end,
        // so an open stdout here was cut off by the deadline or by giving up.
        return trigger === 'unobserved'
          ? { kind: 'abandoned', discardedChars }
          : { kind: 'timed-out', discardedChars, stdoutComplete: false };
    }
  }

  /**
   * Release the pipes. A descendant may still hold their other ends, so they
   * are destroyed rather than awaited. A child whose exit is unobserved no
   * longer keeps the host alive, while its exit is still watched for.
   */
  private release(): void {
    this.child.stdin?.destroy();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    if (this.processExit?.kind === 'unobserved') this.child.unref();
  }

  /**
   * Evidence about the child's process group, for every end of an owned group:
   * a requested stop, an unexpected exit and a failed channel alike. The proof
   * only probes (`kill(-pid, 0)` and the process table) and never signals, so
   * it is safe after the leader's exit. It runs within what is left of the
   * drain window, at most the exit observation time, and ends early at a
   * tighter `close()` deadline; at least one probe runs. On Windows there is no
   * group to probe: the end waits for the `taskkill` of the stop to finish (see
   * `windowsTreeEvidence`), so it never precedes the tree's termination, and
   * reports one that failed, did not finish or never ran (a crash is not
   * followed by any termination, so a Windows tree is then unproven). Never rejects, so the end report
   * it precedes is always delivered.
   * @returns Tree evidence for the end report.
   */
  private async treeEvidence(): Promise<ProcessTreeEvidence> {
    if (this.ownership === 'direct-child') return { kind: 'not-owned' };
    const pid = this.child.pid;
    if (pid === undefined) return { kind: 'quiescent' };
    const windows = (this.stopHost?.platform ?? process.platform) === 'win32';
    // A Windows tree termination that is still running is joined for at most its
    // own bound; the POSIX proof runs within what is left of the drain window.
    const endsAt = windows
      ? Date.now() + this.exitObservationMs
      : Math.min(this.drainEndsAt ?? Date.now(), Date.now() + this.exitObservationMs);
    const proof = { abort: new AbortController(), endsAt };
    this.treeProof = proof;
    this.armTreeProofTimer();
    try {
      if (windows) return await windowsTreeEvidence(this.escalation?.termination, proof.abort.signal);
      return await proveProcessGroupQuiescence(pid, {
        timeoutMs: Math.max(1, this.clamp(endsAt) - Date.now()),
        port: this.signalPort,
        signal: proof.abort.signal,
      });
    } catch {
      return { kind: 'unproven', reason: 'signal-error' };
    } finally {
      clearTimeout(this.treeProofTimer);
      this.treeProof = undefined;
    }
  }

  /** (Re)arm the end of a pending quiescence proof at the earlier of its window and the stop deadline. */
  private armTreeProofTimer(): void {
    clearTimeout(this.treeProofTimer);
    const proof = this.treeProof;
    if (proof === undefined) return;
    this.treeProofTimer = setTimeout(() => proof.abort.abort(), Math.max(0, this.clamp(proof.endsAt) - Date.now()));
  }
}

/**
 * Spawn a subprocess and communicate via newline-delimited JSON on stdin/stdout.
 * @param options - Spawn, policy and timing options.
 * @returns Transport interface for bidirectional JSONL communication.
 */
export function createJsonlTransport(options: JsonlTransportOptions): IJsonlTransport {
  return new JsonlTransport(options);
}
