/**
 * Tmux PTY Backend
 *
 * An {@link IPtyBackend} implementation that manages PTY sessions through the
 * tmux CLI instead of a native addon. Each spawned process becomes a tmux
 * session on a dedicated named server (`-L <serverName>`), keeping all managed
 * sessions isolated from the user's default tmux server.
 *
 * `remain-on-exit on` is set atomically at session creation via a chained
 * tmux command so that the pane buffer and exit status survive even the fastest
 * processes. Output is collected by polling `tmux capture-pane -p -S -` (full
 * scrollback) and forwarding only the incremental delta to registered `onData`
 * listeners. Exit detection polls `tmux list-panes` for the `pane_dead` flag.
 * @packageDocumentation
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { IPtyBackend, IPtyProcess, IPtySpawnOptions } from './types.js';
import { probeProcessPresence } from './process-probe.js';
import type { TmuxCommandOutcome } from './tmux-commands.js';
import { DEFAULT_TMUX_COMMAND_TIMEOUT_MS, runTmuxCommand, tmuxCapture, tmuxExec } from './tmux-commands.js';
import { cleanupStaleOwnedTmuxSessions, MANAGED_SESSION_OPTION, OWNER_PID_OPTION } from './tmux-session-ownership.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Construction options for {@link TmuxBackend}.
 */
export interface TmuxBackendOptions {
  /**
   * Name of the dedicated tmux server socket.
   *
   * All sessions created by this backend run on `-L <serverName>`.
   * Defaults to `'makaio'`.
   */
  serverName?: string;

  /**
   * Polling interval in milliseconds when `onData` listeners are registered.
   *
   * Defaults to `200`.
   */
  pollIntervalMs?: number;

  /**
   * Polling interval in milliseconds used when only `onExit` listeners are
   * registered and there are no active `onData` listeners.
   *
   * Long-running interactive sessions spend most of their lifetime in this
   * exit-only mode, so a slower interval significantly reduces subprocess
   * overhead without affecting output delivery.
   *
   * Defaults to `2000`.
   */
  exitPollIntervalMs?: number;

  /**
   * Whether construction should remove tmux sessions previously created by
   * Makaio whose recorded owner process is no longer alive.
   *
   * Defaults to `true`. Cleanup is limited to sessions carrying Makaio-owned
   * tmux metadata on this backend's server and never kills the server itself.
   */
  cleanupStaleOwnedSessions?: boolean;

  /**
   * Milliseconds any single tmux invocation may block before it is killed.
   *
   * Every tmux call is synchronous, so this bounds how long a wedged `tmux` can
   * hold the event loop. It is also the ceiling on the confirming read
   * {@link IPtyProcess.kill} performs after a successful `kill-session`: a
   * caller that owns an observation budget passes it here so the confirmation
   * can never outlast the budget it is supposed to fit inside.
   *
   * Defaults to {@link DEFAULT_TMUX_COMMAND_TIMEOUT_MS}.
   */
  commandTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pattern matching the tmux "Pane is dead (…)" sentinel appended to the pane
 * buffer when `remain-on-exit on` is set and the process has exited.
 */
const DEAD_PANE_SENTINEL_RE = /\nPane is dead \([^\n]*\)\n?$/;

/**
 * Strip the tmux "Pane is dead (…)" sentinel from a `capture-pane` output.
 *
 * When `remain-on-exit on` is active, tmux appends this line to the visible
 * pane area. It must be removed before comparing or delivering output to
 * `onData` listeners since it is not produced by the spawned process.
 * @param capture - Raw `capture-pane -p -S -` output.
 * @returns Capture string without the dead-pane sentinel.
 */
function stripDeadPaneSentinel(capture: string): string {
  return capture.replace(DEAD_PANE_SENTINEL_RE, '');
}

// ---------------------------------------------------------------------------
// TmuxPtyProcess
// ---------------------------------------------------------------------------

type DataListener = (data: string) => void;
type ExitListener = (e: { exitCode: number; signal?: number }) => void;

/**
 * A running PTY session managed by tmux.
 *
 * Implements {@link IPtyProcess} by translating each interface method into a
 * `tmux` CLI invocation against the session identified by {@link sessionName}.
 * Output and exit events are delivered by polling timers started lazily when
 * the first listener is registered, and stopped when all listeners are removed
 * or the session exits.
 */
class TmuxPtyProcess implements IPtyProcess {
  /** {@inheritdoc} */
  public readonly pid: number;

  /** {@inheritdoc} */
  public readonly process: string;

  private _cols: number;
  private _rows: number;
  private exited = false;

  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();

  /**
   * Callbacks registered via {@link addReleaseHook}, fired once when this
   * session stops being managed. Unlike {@link onExit}, these do not start the
   * polling timer.
   */
  private readonly releaseCallbacks: Array<() => void> = [];

  /** Whether {@link releaseTracking} has already fired the release callbacks. */
  private released = false;

  /**
   * The exit event payload stored by {@link markExited} so that
   * late-registering {@link onExit} listeners receive the actual exit code
   * instead of a hardcoded fallback.
   */
  private exitEvent: { exitCode: number; signal?: number } | undefined;

  /**
   * Last cleaned `capture-pane -S -` result used for incremental diffing.
   *
   * Starts as `null` to distinguish "never polled" from "polled and got empty
   * output", so the first non-null capture always fires an `onData` event even
   * when the content happens to be the empty string.
   */
  private lastCapture: string | null = null;

  /** Active polling timer handle, or `undefined` when polling is stopped. */
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * The interval (ms) that the active `pollTimer` was started with.
   *
   * Tracked so that {@link adjustPolling} can detect when listener state
   * changes warrant restarting the timer at a different interval.
   */
  private activePollIntervalMs: number | undefined;

  /**
   * @param pid - OS PID of the process running inside the tmux pane.
   * @param processName - Executable name (e.g. `'/bin/bash'`).
   * @param sessionName - Unique tmux session identifier on the server.
   * @param serverName - Tmux server socket name.
   * @param initialCols - Initial column width.
   * @param initialRows - Initial row height.
   * @param pollIntervalMs - Milliseconds between polls when data listeners are active.
   * @param exitPollIntervalMs - Milliseconds between polls when only exit listeners are active.
   * @param commandTimeoutMs - Milliseconds any single tmux invocation may block.
   */
  public constructor(
    pid: number,
    processName: string,
    private readonly sessionName: string,
    private readonly serverName: string,
    initialCols: number,
    initialRows: number,
    private readonly pollIntervalMs: number,
    private readonly exitPollIntervalMs: number,
    private readonly commandTimeoutMs: number,
  ) {
    this.pid = pid;
    this.process = processName;
    this._cols = initialCols;
    this._rows = initialRows;
  }

  /**
   * {@inheritdoc}
   * @returns Current column width.
   */
  public get cols(): number {
    return this._cols;
  }

  /**
   * {@inheritdoc}
   * @returns Current row height.
   */
  public get rows(): number {
    return this._rows;
  }

  /**
   * Write raw input to the tmux pane using `send-keys -l`.
   *
   * The `-l` flag treats the string as literal keystrokes, preventing tmux
   * from interpreting control-sequence aliases.
   * @param data - The string to send.
   */
  public write(data: string): void {
    if (this.exited) return;
    try {
      tmuxExec(this.serverName, ['send-keys', '-t', this.sessionName, '-l', '--', data], this.commandTimeoutMs);
    } catch {
      // Session may have died between the guard and this call — ignore.
    }
  }

  /**
   * Send a tmux named key to the pane.
   * @param key - tmux key name, for example `'Escape'`.
   */
  public sendKey(key: string): void {
    if (this.exited) return;
    try {
      tmuxExec(this.serverName, ['send-keys', '-t', this.sessionName, key], this.commandTimeoutMs);
    } catch {
      // Session may have died between the guard and this call — ignore.
    }
  }

  /**
   * Capture the currently visible pane content.
   * @returns Visible pane text, or `null` when the pane no longer exists.
   */
  public captureVisible(): string | null {
    const rawCapture = tmuxCapture(
      this.serverName,
      ['capture-pane', '-t', this.sessionName, '-p'],
      this.commandTimeoutMs,
    );
    return rawCapture === null ? null : stripDeadPaneSentinel(rawCapture);
  }

  /**
   * Resize the tmux window to new dimensions.
   * @param cols - New column width.
   * @param rows - New row height.
   */
  public resize(cols: number, rows: number): void {
    if (this.exited) return;
    try {
      tmuxExec(
        this.serverName,
        ['resize-window', '-t', this.sessionName, '-x', String(cols), '-y', String(rows)],
        this.commandTimeoutMs,
      );
      this._cols = cols;
      this._rows = rows;
    } catch {
      // Session may have died — ignore.
    }
  }

  /**
   * Kill the tmux session.
   *
   * The `signal` argument is accepted for interface compatibility but tmux
   * does not expose per-signal session termination through its CLI; the
   * session is always destroyed via `kill-session`.
   *
   * An exit is published **only** when an end was actually established, never
   * merely because the kill call returned. Three routes establish it, in
   * decreasing order of authority: the kill itself reports that the session was
   * already gone; or — after a kill that succeeded — a confirming read finds it
   * gone; or, when that read establishes nothing, the pane PID turns out to be
   * held by nobody ({@link probePaneProcessAfterInconclusiveRead}). Polling is
   * stopped before the kill, so everything after it has to be acquired here
   * rather than waited for.
   *
   * When no route produces an answer, no exit is published. That is not a lost
   * event but the honest outcome: this session's end was not observed, and a
   * caller waiting on an observation learns it did not arrive instead of being
   * handed one that was never made.
   * @param _signal - Ignored; present for {@link IPtyProcess} compatibility.
   */
  public kill(_signal?: string): void {
    if (this.exited) return;
    this.stopPolling();

    const killStartedAt = Date.now();
    const killOutcome = runTmuxCommand(
      this.serverName,
      ['kill-session', '-t', this.sessionName],
      this.commandTimeoutMs,
    );

    // The kill is committed once the command has been issued, and that — not any
    // evidence outcome — is what ends this backend's management of the session
    // name. Released here so a kill that publishes no exit still stops being
    // tracked. It publishes nothing and nothing below reads it.
    //
    // **Deliberately not conditional on the outcome below, and that is the whole
    // point.** Release answers a resource-ownership question — does this backend
    // still manage this session name — while the outcomes answer an evidence
    // question about the process. A release gated on "delivered, or absence
    // proven" would make ownership a function of an evidence classification, which
    // is the coupling the two questions are kept apart to prevent: the gated form
    // reads as if a tracked entry meant a live session, and the next reader trying
    // to publish an exit from that state has been invited to.
    //
    // What bounds the cost, for the one outcome where the release is not backed by
    // an answer: an `unanswerable` kill releases a session {@link dispose} will
    // then not re-kill, so the honest limit is the construction-time stale-owner
    // sweep ({@link cleanupStaleOwnedTmuxSessions}) — it reaps Makaio-owned
    // sessions whose owner process is gone, so such a session outlives this
    // process at most until the next backend is built. The price of the stale
    // entry itself is one redundant `kill-session`.
    this.releaseTracking();

    if (killOutcome.kind === 'answered-negative') {
      // The server itself reports no such session: absence is proven, and the
      // pane's process is gone by the same authority that would have run it.
      this.markExited(0);
      return;
    }

    if (killOutcome.kind !== 'answered') {
      // The kill either failed for an unrelated reason or never reached a
      // server. The session may still be running; nothing may be published.
      return;
    }

    this.confirmAbsenceAfterKill(this.commandTimeoutMs - (Date.now() - killStartedAt));
  }

  /**
   * Confirm this session's absence after a `kill-session` that succeeded.
   *
   * Bounded by whatever is left of the caller's command budget once the kill
   * has returned, because the call is synchronous: no concurrent timer can end
   * a blocked read, so the read's own timeout is the only thing keeping the
   * budget honest. An expired budget asked nobody, which is the same as a read
   * that never reached a server.
   *
   * A server's own *no such session* stays the primary answer, because it is
   * truth about this session rather than about a PID. Only when that read comes
   * back inconclusive does the pane PID get a say — see
   * {@link probePaneProcessAfterInconclusiveRead}.
   * @param remainingBudgetMs - Milliseconds left of the command budget.
   */
  private confirmAbsenceAfterKill(remainingBudgetMs: number): void {
    const confirmation: TmuxCommandOutcome =
      remainingBudgetMs > 0
        ? runTmuxCommand(this.serverName, ['has-session', '-t', this.sessionName], remainingBudgetMs)
        : { kind: 'unanswerable' };

    if (confirmation.kind === 'answered-negative') {
      this.markExited(0);
      return;
    }

    // The server answered that the session is still there. That is a refutation,
    // not an inconclusive read, so the local probe has nothing to add.
    if (confirmation.kind === 'answered') return;

    this.probePaneProcessAfterInconclusiveRead();
  }

  /**
   * Fall back to the pane PID when the post-kill read established nothing.
   *
   * The case this exists for is the killed session having been the **last** on
   * its tmux server: the server dies with it, the confirming read answers *"no
   * server running"*, and that proves nothing about the pane — a tmux server
   * going away does not end the processes it started. The PID this backend
   * captured at session creation does prove it, in exactly one direction.
   *
   * Only proven absence is acted on. A signalable PID may be a recycled one
   * belonging to somebody else, and so may a PID this runtime is not allowed to
   * signal; recycling can make a dead process look alive but never a live one
   * look dead, so the outcome claimed here is the one it cannot fabricate. On
   * either inconclusive outcome nothing is published and the caller's wait ends
   * without an observation.
   *
   * An exit here means the process spawned *in the pane* has ended. Anything
   * that pane process started in turn is not this backend's resource and was
   * never covered by an exit event.
   */
  private probePaneProcessAfterInconclusiveRead(): void {
    if (probeProcessPresence(this.pid) === 'absent') {
      this.markExited(0);
    }
  }

  /**
   * Register a listener for output data.
   *
   * Starts the polling timer if it is not already running. If the timer is
   * currently running at the slow exit-only interval, it is restarted at the
   * faster data interval.
   * @param listener - Callback invoked with each incremental output chunk.
   * @returns A disposable that unregisters the listener.
   */
  public onData(listener: DataListener): { dispose(): void } {
    this.dataListeners.add(listener);
    this.adjustPolling();
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
        this.adjustPolling();
      },
    };
  }

  /**
   * Register a listener for the process exit event.
   *
   * Starts the polling timer if it is not already running.
   * If the process has already exited, fires the listener synchronously.
   * @param listener - Callback invoked when the pane's process exits.
   * @returns A disposable that unregisters the listener.
   */
  public onExit(listener: ExitListener): { dispose(): void } {
    if (this.exited) {
      // Deliver exit synchronously to late-registering listeners using the
      // stored exit event so the actual exit code is forwarded.
      listener(this.exitEvent ?? { exitCode: 0 });
      return { dispose: () => {} };
    }
    this.exitListeners.add(listener);
    this.adjustPolling();
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
        this.adjustPolling();
      },
    };
  }

  // ── Polling internals ────────────────────────────────────────────────────────

  /**
   * Select the appropriate polling interval for the current listener state.
   *
   * Returns the fast data-polling interval when data listeners are registered,
   * the slow exit-only interval when only exit listeners are registered, and
   * `undefined` when no listeners are present.
   * @returns The desired polling interval in milliseconds, or `undefined`.
   */
  private desiredInterval(): number | undefined {
    if (this.dataListeners.size > 0) return this.pollIntervalMs;
    if (this.exitListeners.size > 0) return this.exitPollIntervalMs;
    return undefined;
  }

  /**
   * Reconcile the running poll timer with the current listener state.
   *
   * - If no listeners remain, the timer is cancelled.
   * - If listeners are present and no timer is running, one is started.
   * - If a timer is already running but at the wrong interval (because
   *   a data listener was added or removed), it is restarted at the correct
   *   interval.
   *
   * This is the single entry-point called whenever the listener sets change.
   */
  private adjustPolling(): void {
    if (this.exited) return;

    const desired = this.desiredInterval();

    if (desired === undefined) {
      this.stopPolling();
      return;
    }

    if (this.pollTimer !== undefined && this.activePollIntervalMs === desired) {
      // Already running at the correct interval — nothing to do.
      return;
    }

    // Either not running yet, or running at the wrong interval.
    this.stopPolling();
    this.activePollIntervalMs = desired;
    this.pollTimer = setInterval(() => this.poll(), desired);
  }

  /**
   * Cancel the polling timer unconditionally.
   */
  private stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
      this.activePollIntervalMs = undefined;
    }
  }

  /**
   * Single polling tick: capture new output and check for pane death.
   *
   * Uses `-S -` to capture the full scrollback history so output from
   * fast-exiting commands is not lost. The "Pane is dead" sentinel injected by
   * `remain-on-exit on` is stripped before comparing against the last capture.
   */
  private poll(): void {
    if (this.exited) {
      this.stopPolling();
      return;
    }

    // ── Data polling ──────────────────────────────────────────────────────────
    if (this.dataListeners.size > 0) {
      // `-S -` captures the full scrollback so output from fast processes is
      // not discarded by the visible-area-only default.
      const rawCapture = tmuxCapture(
        this.serverName,
        ['capture-pane', '-t', this.sessionName, '-p', '-S', '-'],
        this.commandTimeoutMs,
      );

      if (rawCapture !== null) {
        const capture = stripDeadPaneSentinel(rawCapture);
        if (capture !== this.lastCapture) {
          const newContent = this.diffCapture(this.lastCapture, capture);
          this.lastCapture = capture;
          if (newContent.length > 0) {
            for (const listener of this.dataListeners) {
              listener(newContent);
            }
          }
        }
      }
    }

    // ── Exit polling ──────────────────────────────────────────────────────────
    this.checkExit();
  }

  /**
   * Compute the incremental content added since the last capture.
   *
   * Because `capture-pane -S -` returns the full scrollback history on every
   * call, only the suffix that was not present in the previous capture needs
   * to be emitted. When the current capture no longer starts with the previous
   * one (e.g. because the terminal cleared the screen), the full current
   * capture is emitted to avoid dropping output.
   * @param previous - Previous full pane capture, or `null` on the first call.
   * @param current - Current full pane capture.
   * @returns Incremental string to emit to `onData` listeners.
   */
  private diffCapture(previous: string | null, current: string): string {
    if (previous === null || previous.length === 0) {
      return current;
    }
    if (current.startsWith(previous)) {
      return current.slice(previous.length);
    }
    // Screen was cleared or terminal scrolled differently — emit the full new
    // capture rather than silently dropping output.
    return current;
  }

  /**
   * Query tmux for the pane dead status and fire exit listeners if the process
   * has terminated.
   *
   * Once the pane is confirmed dead, kills the lingering session (left alive by
   * `remain-on-exit on`) and calls {@link markExited}.
   *
   * A failed poll is not an exit. Only a live server reporting that the session
   * does not exist proves absence; a poll that never reached a server proves
   * nothing, because a tmux server can go away while a process it started keeps
   * running. Such a poll therefore publishes nothing and leaves the session in
   * its unobserved state.
   */
  private checkExit(): void {
    const listing = runTmuxCommand(
      this.serverName,
      ['list-panes', '-t', this.sessionName, '-F', '#{pane_dead}:#{pane_dead_status}'],
      this.commandTimeoutMs,
    );

    if (listing.kind === 'answered-negative') {
      // A live server reports no such session — absence proven, clean exit.
      this.markExited(0);
      return;
    }

    if (listing.kind !== 'answered') return;

    const result = listing.stdout;
    const colonIdx = result.indexOf(':');
    if (colonIdx === -1) return;

    const isDead = result.slice(0, colonIdx) === '1';
    if (isDead) {
      const exitCode = parseInt(result.slice(colonIdx + 1), 10);
      // Clean up the dead session — `remain-on-exit on` kept it alive only so
      // we could read the exit code; it is no longer needed.
      runTmuxCommand(this.serverName, ['kill-session', '-t', this.sessionName], this.commandTimeoutMs);
      this.markExited(Number.isFinite(exitCode) ? exitCode : 0);
    }
  }

  /**
   * Mark this process as exited and fire all registered exit listeners exactly
   * once, then release this session's tracking.
   * @param exitCode - The process exit code to deliver to listeners.
   * @param signal - Optional signal number that caused the exit.
   */
  private markExited(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    this.exitEvent = { exitCode, signal };
    this.stopPolling();
    for (const listener of this.exitListeners) {
      listener(this.exitEvent);
    }
    this.exitListeners.clear();
    this.releaseTracking();
  }

  /**
   * Fire the release hooks once, whichever event got here first.
   *
   * Release answers *"does this backend still manage this session name"*, which
   * is a resource-ownership question and not evidence: it publishes no exit, does
   * not touch {@link exited}, and cannot influence any class a caller reports.
   */
  private releaseTracking(): void {
    if (this.released) return;
    this.released = true;
    for (const fn of this.releaseCallbacks) {
      fn();
    }
  }

  /**
   * Register an internal hook that is called once this session stops being
   * managed by its backend — at the earlier of the kill being committed and an
   * exit being published.
   *
   * Unlike {@link onExit}, this does **not** start the polling timer, making it
   * safe for backend-internal housekeeping (e.g. removing a session from the
   * active-sessions map) without unintended side effects.
   * @param fn - Callback to invoke once when the session is released.
   */
  public addReleaseHook(fn: () => void): void {
    if (this.released) {
      fn();
      return;
    }
    this.releaseCallbacks.push(fn);
  }

  /**
   * Stop all polling and release listener sets without firing any events.
   *
   * Called by {@link TmuxBackend.dispose} to clean up in-flight sessions
   * without triggering exit callbacks.
   */
  public teardown(): void {
    this.stopPolling();
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}

// ---------------------------------------------------------------------------
// TmuxBackend
// ---------------------------------------------------------------------------

/**
 * PTY backend that manages processes as tmux sessions.
 *
 * Each call to {@link spawn} creates a detached tmux session on a dedicated
 * tmux server (`-L <serverName>`). The session name is derived from a random
 * UUID to ensure uniqueness across concurrent sessions.
 *
 * `remain-on-exit on` is chained atomically in the `new-session` call so that
 * the pane buffer and exit status survive even processes that exit immediately.
 * Output and exit events are delivered by polling the tmux CLI. `tmux` must be
 * present on `PATH`.
 * @example
 * ```typescript
 * const backend = new TmuxBackend({ serverName: 'makaio' });
 * const proc = await backend.spawn('/bin/bash', [], { cols: 80, rows: 24 });
 * proc.onData((data) => process.stdout.write(data));
 * proc.write('echo hello\r');
 * ```
 */
export class TmuxBackend implements IPtyBackend {
  private readonly serverName: string;
  private readonly pollIntervalMs: number;
  private readonly exitPollIntervalMs: number;
  private readonly commandTimeoutMs: number;
  private readonly activeSessions = new Map<string, TmuxPtyProcess>();

  /**
   * Set to `true` after {@link dispose} is called. Guards against further
   * {@link spawn} calls on a torn-down backend.
   */
  private disposed = false;

  /**
   * @param options - Backend configuration.
   */
  public constructor(options: TmuxBackendOptions = {}) {
    this.serverName = options.serverName ?? 'makaio';
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.exitPollIntervalMs = options.exitPollIntervalMs ?? 2000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_TMUX_COMMAND_TIMEOUT_MS;
    if (options.cleanupStaleOwnedSessions !== false) {
      cleanupStaleOwnedTmuxSessions(this.serverName, this.commandTimeoutMs);
    }
  }

  /**
   * Spawn a new process inside a dedicated tmux session.
   *
   * The pane PID is returned atomically by `-P -F '#{pane_pid}'` so there is
   * no race between session creation and PID query. `remain-on-exit on` is set
   * in the same invocation via a chained `;` tmux command, ensuring the pane
   * buffer outlives even the fastest process.
   *
   * If `options.name` is provided it is forwarded as the `TERM` environment
   * variable via tmux's `-e` flag, consistent with the node-pty backend
   * behaviour. An explicit `TERM` entry in `options.env` takes precedence.
   * @param file - Executable path or name to run inside the tmux session.
   * @param args - Argument list forwarded to the executable.
   * @param options - PTY dimensions, working directory, and environment.
   * @returns Resolves with the running PTY process handle.
   * @throws If the backend has been disposed.
   */
  public async spawn(file: string, args: string[], options: IPtySpawnOptions): Promise<IPtyProcess> {
    if (this.disposed) {
      throw new Error('TmuxBackend has been disposed');
    }

    const sessionName = `makaio-${randomUUID()}`;
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;

    // `-P -F '#{pane_pid}'` prints the pane PID to stdout at creation time,
    // eliminating the need for a follow-up `display-message` query.
    const newSessionArgs = [
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-x',
      String(cols),
      '-y',
      String(rows),
      '-P',
      '-F',
      '#{pane_pid}',
    ];

    if (options.cwd !== undefined) {
      newSessionArgs.push('-c', options.cwd);
    }

    // Forward `options.name` as the TERM environment variable so callers that
    // set `name` get consistent behaviour across backends. An explicit `TERM`
    // in `options.env` takes precedence over `options.name`.
    if (options.name !== undefined && options.env?.['TERM'] === undefined) {
      newSessionArgs.push('-e', `TERM=${options.name}`);
    }

    // Pass environment variables using repeated `-e KEY=VALUE` flags.
    if (options.env !== undefined) {
      for (const [key, value] of Object.entries(options.env)) {
        newSessionArgs.push('-e', `${key}=${value}`);
      }
    }

    // Append the command and its arguments as positional parameters.
    newSessionArgs.push(file, ...args);

    // Chain `set-option remain-on-exit on` in the same tmux invocation.
    // tmux treats `;` (as a separate argv element) as a command separator,
    // which is safe with execFileSync since no shell interpretation occurs.
    newSessionArgs.push(
      ';',
      'set-option',
      '-t',
      sessionName,
      MANAGED_SESSION_OPTION,
      '1',
      ';',
      'set-option',
      '-t',
      sessionName,
      OWNER_PID_OPTION,
      String(process.pid),
      ';',
      'set-option',
      'remain-on-exit',
      'on',
    );

    let pid: number;
    try {
      const pidStr = tmuxExec(this.serverName, newSessionArgs, this.commandTimeoutMs);
      pid = parseInt(pidStr, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        throw new Error(`Unexpected pane_pid value: '${pidStr}'`);
      }
    } catch (err) {
      runTmuxCommand(this.serverName, ['kill-session', '-t', sessionName], this.commandTimeoutMs);
      return Promise.reject(err instanceof Error ? err : new Error(`tmux new-session failed: ${String(err)}`));
    }

    const proc = new TmuxPtyProcess(
      pid,
      file,
      sessionName,
      this.serverName,
      cols,
      rows,
      this.pollIntervalMs,
      this.exitPollIntervalMs,
      this.commandTimeoutMs,
    );

    this.activeSessions.set(sessionName, proc);

    // Use addReleaseHook instead of onExit so that removing the session from
    // the active map does not start the polling timer as a side effect.
    proc.addReleaseHook(() => {
      this.activeSessions.delete(sessionName);
    });

    return proc;
  }

  /**
   * Dispose the backend by killing each session spawned by this instance.
   *
   * Only the sessions tracked in {@link activeSessions} (i.e. those created by
   * this backend) are killed. Other backends sharing the same tmux server name
   * are unaffected because `kill-server` is intentionally avoided here.
   *
   * Sets the disposed flag so subsequent {@link spawn} calls throw immediately.
   * Polling timers and listener sets are cancelled before the tmux sessions are
   * killed.
   * @returns Resolves when teardown is complete.
   */
  public async dispose(): Promise<void> {
    this.disposed = true;
    for (const [sessionName, proc] of this.activeSessions) {
      proc.teardown();
      runTmuxCommand(this.serverName, ['kill-session', '-t', sessionName], this.commandTimeoutMs);
    }
    this.activeSessions.clear();
  }
}

/**
 * Determine whether the `tmux` executable is accessible on `PATH`.
 *
 * Used by test suites to conditionally skip integration tests on hosts where
 * tmux is not installed.
 * @returns `true` if `tmux -V` exits successfully, `false` otherwise.
 */
export function isTmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe', timeout: DEFAULT_TMUX_COMMAND_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}
