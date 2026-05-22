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
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a tmux command on the given server, returning stdout as a trimmed string.
 *
 * Uses `execFileSync` for safety: arguments are passed as an array so they
 * are never interpolated through a shell.
 * @param serverName - Tmux server socket name (passed as `-L <serverName>`).
 * @param args - Remaining tmux subcommand and arguments.
 * @returns Trimmed stdout string (may be empty).
 * @throws If the tmux process exits with a non-zero code.
 */
function tmuxExec(serverName: string, args: string[]): string {
  const output = execFileSync('tmux', ['-L', serverName, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.trim();
}

/**
 * Run a tmux command, returning `null` instead of throwing on failure.
 *
 * Used for polling operations where the session may no longer exist.
 * @param serverName - Tmux server socket name.
 * @param args - Remaining tmux subcommand and arguments.
 * @returns Trimmed stdout string, or `null` if the command failed.
 */
function tmuxExecSafe(serverName: string, args: string[]): string | null {
  try {
    return tmuxExec(serverName, args);
  } catch {
    return null;
  }
}

/**
 * Run a tmux command, returning the raw (untrimmed) stdout string.
 *
 * Used for `capture-pane` where trailing newlines are significant for
 * incremental diffing.
 * @param serverName - Tmux server socket name.
 * @param args - Remaining tmux subcommand and arguments.
 * @returns Raw stdout string, or `null` if the command failed.
 */
function tmuxCapture(serverName: string, args: string[]): string | null {
  try {
    const output = execFileSync('tmux', ['-L', serverName, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output;
  } catch {
    return null;
  }
}

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

const MANAGED_SESSION_OPTION = '@makaio-managed';
const OWNER_PID_OPTION = '@makaio-owner-pid';

/**
 * Parse a positive integer from tmux user-option output.
 * @param value - Raw tmux format value.
 * @returns Parsed positive integer, or `undefined` when invalid.
 */
function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Check whether an owner process is still alive.
 * @param pid - Process identifier recorded in tmux metadata.
 * @returns `true` when the process exists or cannot be signalled due to permissions.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove stale Makaio-owned tmux sessions from a server.
 *
 * Only sessions carrying both the managed marker and an owner PID are eligible.
 * Unmarked user sessions and sessions owned by a live process are preserved.
 * @param serverName - Tmux server socket name.
 */
function cleanupStaleOwnedTmuxSessions(serverName: string): void {
  const raw = tmuxExecSafe(serverName, [
    'list-sessions',
    '-F',
    `#{session_name}\t#{${MANAGED_SESSION_OPTION}}\t#{${OWNER_PID_OPTION}}`,
  ]);
  if (!raw) {
    return;
  }

  for (const line of raw.split('\n')) {
    const [sessionName, managedMarker, ownerPidRaw] = line.split('\t');
    if (!sessionName || managedMarker !== '1') {
      continue;
    }

    const ownerPid = parsePositiveInteger(ownerPidRaw);
    if (ownerPid === undefined || isProcessAlive(ownerPid)) {
      continue;
    }

    tmuxExecSafe(serverName, ['kill-session', '-t', sessionName]);
  }
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
   * Callbacks registered via {@link addCleanupHook} that are fired after all
   * exit listeners have been notified. Unlike {@link onExit}, these do not
   * start the polling timer.
   */
  private readonly cleanupCallbacks: Array<() => void> = [];

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
      tmuxExec(this.serverName, ['send-keys', '-t', this.sessionName, '-l', '--', data]);
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
      tmuxExec(this.serverName, ['send-keys', '-t', this.sessionName, key]);
    } catch {
      // Session may have died between the guard and this call — ignore.
    }
  }

  /**
   * Capture the currently visible pane content.
   * @returns Visible pane text, or `null` when the pane no longer exists.
   */
  public captureVisible(): string | null {
    const rawCapture = tmuxCapture(this.serverName, ['capture-pane', '-t', this.sessionName, '-p']);
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
      tmuxExec(this.serverName, ['resize-window', '-t', this.sessionName, '-x', String(cols), '-y', String(rows)]);
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
   * Exit listeners receive `exitCode: 0` for this forced termination path
   * because polling stops before the pane can report its natural exit status.
   * @param _signal - Ignored; present for {@link IPtyProcess} compatibility.
   */
  public kill(_signal?: string): void {
    if (this.exited) return;
    this.stopPolling();
    try {
      tmuxExec(this.serverName, ['kill-session', '-t', this.sessionName]);
    } catch {
      // Already gone.
    }
    this.markExited(0);
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
      const rawCapture = tmuxCapture(this.serverName, ['capture-pane', '-t', this.sessionName, '-p', '-S', '-']);

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
   */
  private checkExit(): void {
    const result = tmuxExecSafe(this.serverName, [
      'list-panes',
      '-t',
      this.sessionName,
      '-F',
      '#{pane_dead}:#{pane_dead_status}',
    ]);

    if (result === null) {
      // Session no longer exists — treat as clean exit.
      this.markExited(0);
      return;
    }

    const colonIdx = result.indexOf(':');
    if (colonIdx === -1) return;

    const isDead = result.slice(0, colonIdx) === '1';
    if (isDead) {
      const exitCode = parseInt(result.slice(colonIdx + 1), 10);
      // Clean up the dead session — `remain-on-exit on` kept it alive only so
      // we could read the exit code; it is no longer needed.
      tmuxExecSafe(this.serverName, ['kill-session', '-t', this.sessionName]);
      this.markExited(Number.isFinite(exitCode) ? exitCode : 0);
    }
  }

  /**
   * Mark this process as exited and fire all registered exit listeners exactly
   * once, then run any cleanup hooks registered via {@link addCleanupHook}.
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
    for (const fn of this.cleanupCallbacks) {
      fn();
    }
  }

  /**
   * Register an internal cleanup hook that is called after all exit listeners
   * have been notified.
   *
   * Unlike {@link onExit}, this does **not** start the polling timer, making it
   * safe for backend-internal housekeeping (e.g. removing a session from the
   * active-sessions map) without unintended side effects.
   * @param fn - Callback to invoke once when the process exits.
   */
  public addCleanupHook(fn: () => void): void {
    if (this.exited) {
      fn();
      return;
    }
    this.cleanupCallbacks.push(fn);
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
    if (options.cleanupStaleOwnedSessions !== false) {
      cleanupStaleOwnedTmuxSessions(this.serverName);
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
      const pidStr = tmuxExec(this.serverName, newSessionArgs);
      pid = parseInt(pidStr, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        throw new Error(`Unexpected pane_pid value: '${pidStr}'`);
      }
    } catch (err) {
      tmuxExecSafe(this.serverName, ['kill-session', '-t', sessionName]);
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
    );

    this.activeSessions.set(sessionName, proc);

    // Use addCleanupHook instead of onExit so that removing the session from
    // the active map does not start the polling timer as a side effect.
    proc.addCleanupHook(() => {
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
      tmuxExecSafe(this.serverName, ['kill-session', '-t', sessionName]);
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
    execFileSync('tmux', ['-V'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
