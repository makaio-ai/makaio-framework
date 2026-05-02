/**
 * PTY Runtime
 *
 * Manages the lifecycle of spawned PTY sessions for the native session
 * supervisor. Owns process spawning, input/output, output buffering,
 * subscriber tracking, and disconnect-based orphan cleanup.
 *
 * This class is intentionally free of bus or transport concerns — the
 * supervisor service wires bus handlers to the runtime's public API.
 * @packageDocumentation
 */

import { OutputBuffer } from './output-buffer.js';
import { CLEANUP_INTERVAL_MS, getDisconnectDuration, shouldCleanupSession } from './session-cleanup.js';
import type { CleanupableSession } from './session-cleanup.js';
import type { IPtyBackend, IPtyProcess, IPtySpawnOptions, PtyExitEvent, PtyOutputEvent } from './types.js';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Minimal structured logger contract for {@link PtyRuntime}.
 *
 * Defaults to `console`, allowing callers to inject structured logging.
 */
export interface PtyLogger {
  /** Log an informational message. */
  info(message: string, ...args: unknown[]): void;
  /** Log a warning message. */
  warn(message: string, ...args: unknown[]): void;
  /** Log an error message. */
  error(message: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Internal session record
// ---------------------------------------------------------------------------

/**
 * Internal record for a single active PTY session.
 */
interface PtySession {
  /** Stable supervisor-assigned session ID (primary key). */
  supervisorSessionId: string;
  /** The underlying PTY process handle. */
  pty: IPtyProcess;
  /** Disposables to release when the session is torn down. */
  disposables: Array<{ dispose: () => void }>;
  /** Output buffer for reconnection replay. */
  outputBuffer: OutputBuffer;
  /** Number of active subscribers (0 means buffering mode). */
  activeSubscriptions: number;
  /** Latest output sequence number. */
  lastSeq: number;
  /** Unix epoch timestamp of the last I/O activity. */
  lastActivity: number;
  /** Unix epoch timestamp when the last subscriber disconnected, or null. */
  disconnectedAt: number | null;
}

// ---------------------------------------------------------------------------
// Public spawn options
// ---------------------------------------------------------------------------

/**
 * Parameters for spawning a new PTY session via {@link PtyRuntime.spawn}.
 */
export interface PtySpawnParams {
  /**
   * Stable supervisor-assigned session ID. Used as the primary key for all
   * subsequent lookups and as the correlation key in output/exit events.
   */
  supervisorSessionId: string;
  /** Executable file to run (absolute path or name resolvable via PATH). */
  file: string;
  /** Argument list passed to the executable. */
  args: string[];
  /** PTY spawn options: cwd, env, dimensions, terminal name. */
  options: IPtySpawnOptions;
}

// ---------------------------------------------------------------------------
// PtyRuntime
// ---------------------------------------------------------------------------

/**
 * Manages the full lifecycle of supervised PTY sessions.
 *
 * Responsibilities:
 * - Spawning PTY processes via a pluggable {@link IPtyBackend}.
 * - Buffering output for reconnection replay.
 * - Tracking subscriber counts to decide when to buffer vs. stream.
 * - Cleaning up orphaned sessions after a configurable disconnect timeout.
 * @example
 * ```typescript
 * const runtime = new PtyRuntime(backend, {
 *   onOutput: (evt) => bus.emit('output', evt),
 *   onExit:   (evt) => bus.emit('exit', evt),
 * });
 * runtime.init();
 *
 * await runtime.spawn({
 *   supervisorSessionId: 'sup_abc',
 *   file: '/bin/bash',
 *   args: [],
 *   options: { cwd: '/home/user', cols: 80, rows: 24 },
 * });
 * ```
 */
export class PtyRuntime {
  private readonly sessions = new Map<string, PtySession>();
  private readonly logger: PtyLogger;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * @param backend - PTY backend used to spawn processes.
   * @param handlers - Output and exit event callbacks.
   * @param logger - Optional structured logger. Defaults to `console`.
   */
  public constructor(
    private readonly backend: IPtyBackend,
    private readonly handlers: {
      /**
       * Called when a PTY session emits output and at least one subscriber is
       * active. The buffer always receives the data regardless.
       * @param evt - Output event with session ID, sequence number, and data.
       */
      onOutput: (evt: PtyOutputEvent) => void;
      /**
       * Called when a PTY process terminates.
       * @param evt - Exit event with session ID and exit code.
       */
      onExit: (evt: PtyExitEvent) => void;
    },
    logger: PtyLogger = console,
  ) {
    this.logger = logger;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the orphan-cleanup background loop.
   *
   * Must be called once before `spawn()` is used. Calling `init()` a second
   * time is a no-op.
   */
  public init(): void {
    if (this.cleanupInterval !== null) return;
    this.cleanupInterval = setInterval(() => {
      this.cleanupOrphans();
    }, CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop the cleanup loop, kill all active PTY sessions, and release backend
   * resources.
   *
   * Calling `destroy()` before `init()` is a no-op.
   * @returns Promise that resolves when teardown is complete.
   */
  public async destroy(): Promise<void> {
    if (this.cleanupInterval === null) return;

    clearInterval(this.cleanupInterval);
    this.cleanupInterval = null;

    for (const session of this.sessions.values()) {
      session.disposables.forEach((d) => d.dispose());
      this.killPty(session.pty);
    }
    this.sessions.clear();

    await this.backend.dispose?.();
  }

  // ---------------------------------------------------------------------------
  // Process control
  // ---------------------------------------------------------------------------

  /**
   * Spawn a new PTY session for the given supervisor session ID.
   *
   * If a session already exists for `supervisorSessionId`, it is killed and
   * replaced. The new session starts with zero active subscribers and
   * `disconnectedAt` set to the spawn timestamp so that the orphan-cleanup
   * loop can reap it if no subscriber calls {@link connect} within the
   * configured timeout.
   * @param params - Spawn parameters including supervisor session ID and PTY options.
   * @returns Promise that resolves with the OS PID once the process is running.
   */
  public async spawn(params: PtySpawnParams): Promise<{ pid: number; processName: string }> {
    if (this.cleanupInterval === null) {
      throw new Error('PtyRuntime.spawn called before init()');
    }

    const { supervisorSessionId, file, args, options } = params;

    let ptyProcess: IPtyProcess;
    try {
      ptyProcess = await this.backend.spawn(file, args, options);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to spawn PTY (file=${file}): ${msg}`);
    }

    // Guard: if destroy() ran during the async spawn, kill the new PTY and bail.
    if (this.cleanupInterval === null) {
      this.killPty(ptyProcess);
      throw new Error('PtyRuntime was destroyed while spawn was in progress');
    }

    // Replace any pre-existing session with the same ID.
    const existing = this.sessions.get(supervisorSessionId);
    if (existing !== undefined) {
      existing.disposables.forEach((d) => d.dispose());
      this.killPty(existing.pty);
      this.sessions.delete(supervisorSessionId);
    }

    const now = Date.now();

    const onDataDisposable = ptyProcess.onData((data) => {
      const session = this.sessions.get(supervisorSessionId);
      if (session === undefined) return;

      session.lastSeq += 1;
      session.lastActivity = Date.now();
      session.outputBuffer.push(session.lastSeq, data);

      if (session.activeSubscriptions > 0) {
        this.handlers.onOutput({ supervisorSessionId, seq: session.lastSeq, data });
      }
    });

    const onExitDisposable = ptyProcess.onExit(({ exitCode, signal }) => {
      const session = this.sessions.get(supervisorSessionId);
      session?.disposables.forEach((d) => d.dispose());
      this.sessions.delete(supervisorSessionId);

      this.handlers.onExit({ supervisorSessionId, exitCode, signal });
    });

    this.sessions.set(supervisorSessionId, {
      supervisorSessionId,
      pty: ptyProcess,
      disposables: [onDataDisposable, onExitDisposable],
      outputBuffer: new OutputBuffer(),
      activeSubscriptions: 0,
      lastSeq: 0,
      lastActivity: now,
      disconnectedAt: now,
    });

    return { pid: ptyProcess.pid, processName: ptyProcess.process };
  }

  /**
   * Write input data to an active PTY session.
   * @param supervisorSessionId - Supervisor session ID.
   * @param data - String to write to the PTY stdin.
   * @returns `true` if the session was found and the write was forwarded.
   */
  public write(supervisorSessionId: string, data: string): boolean {
    const session = this.sessions.get(supervisorSessionId);
    if (session === undefined) return false;

    session.pty.write(data);
    session.lastActivity = Date.now();
    return true;
  }

  /**
   * Resize the terminal dimensions of an active PTY session.
   * @param supervisorSessionId - Supervisor session ID.
   * @param cols - New column width.
   * @param rows - New row height.
   * @returns `true` if the session was found and the resize was applied.
   */
  public resize(supervisorSessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(supervisorSessionId);
    if (session === undefined) return false;

    session.pty.resize(cols, rows);
    return true;
  }

  /**
   * Kill an active PTY session (best-effort, idempotent).
   *
   * If the underlying process has already exited, the error is swallowed
   * and the method still returns `true` (session was found). This makes
   * `kill()` safe to call during teardown races without try/catch at every
   * call site.
   * @param supervisorSessionId - Supervisor session ID.
   * @param signal - Signal to send. Defaults to `'SIGHUP'`.
   * @returns `true` if the session was found.
   */
  public kill(supervisorSessionId: string, signal?: string): boolean {
    const session = this.sessions.get(supervisorSessionId);
    if (session === undefined) return false;

    try {
      session.pty.kill(signal ?? 'SIGHUP');
    } catch {
      /* Process already exited — expected during teardown races. */
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Subscriber tracking
  // ---------------------------------------------------------------------------

  /**
   * Register a new subscriber for a session.
   *
   * Clears the disconnect timestamp and returns buffered output since
   * `sinceSeq` for replay.
   * @param supervisorSessionId - Supervisor session ID.
   * @param sinceSeq - Last sequence number the subscriber has seen.
   *   Pass `null` to receive all buffered output.
   * @returns The buffered replay data, or `null` when the session does not exist.
   */
  public connect(
    supervisorSessionId: string,
    sinceSeq: number | null,
  ): {
    bufferedOutput: string;
    wasTruncated: boolean;
    lastSeq: number;
    pid: number;
    processName: string;
  } | null {
    const session = this.sessions.get(supervisorSessionId);
    if (session === undefined) return null;

    session.activeSubscriptions += 1;
    session.lastActivity = Date.now();
    session.disconnectedAt = null;

    const bufferResult = session.outputBuffer.getSince(sinceSeq);
    return {
      bufferedOutput: bufferResult.content,
      wasTruncated: bufferResult.wasTruncated,
      lastSeq: session.lastSeq,
      pid: session.pty.pid,
      processName: session.pty.process,
    };
  }

  /**
   * Unregister one subscriber from a session.
   *
   * When the subscriber count reaches zero the disconnect timestamp is set,
   * starting the orphan-cleanup countdown.
   * @param supervisorSessionId - Supervisor session ID.
   * @returns `true` if the session was found.
   */
  public disconnect(supervisorSessionId: string): boolean {
    const session = this.sessions.get(supervisorSessionId);
    if (session === undefined) return false;

    if (session.activeSubscriptions > 0) {
      session.activeSubscriptions -= 1;
    }
    if (session.activeSubscriptions === 0 && session.disconnectedAt === null) {
      session.disconnectedAt = Date.now();
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Buffer access
  // ---------------------------------------------------------------------------

  /**
   * Retrieve the current status and buffered output for a session.
   * @param supervisorSessionId - Supervisor session ID.
   * @returns Session status, or `null` when the session does not exist.
   */
  public getSessionStatus(supervisorSessionId: string): {
    pid: number;
    processName: string;
    bufferedOutput: string;
    wasTruncated: boolean;
    lastSeq: number;
    activeSubscriptions: number;
    disconnectedAt: number | null;
  } | null {
    const session = this.sessions.get(supervisorSessionId);
    if (session === undefined) return null;

    return {
      pid: session.pty.pid,
      processName: session.pty.process,
      bufferedOutput: session.outputBuffer.getContent(),
      wasTruncated: session.outputBuffer.wasTruncated(),
      lastSeq: session.lastSeq,
      activeSubscriptions: session.activeSubscriptions,
      disconnectedAt: session.disconnectedAt,
    };
  }

  /**
   * Retrieve a paginated slice of buffered output for a session.
   * @param supervisorSessionId - Supervisor session ID.
   * @param lastNLines - Number of lines from the end to consider. `null` uses
   *   the full buffer.
   * @param offset - Byte offset into the filtered content.
   * @param limit - Maximum byte count to return.
   * @returns Paginated output, or `null` when the session does not exist.
   */
  public getScrollback(
    supervisorSessionId: string,
    lastNLines: number | null,
    offset: number,
    limit: number,
  ): {
    content: string;
    totalSize: number;
    offset: number;
    hasMore: boolean;
    wasTruncated: boolean;
    processName: string;
  } | null {
    const session = this.sessions.get(supervisorSessionId);
    if (session === undefined) return null;

    const readResult = session.outputBuffer.getLastNLines(lastNLines);
    const totalSize = readResult.content.length;
    const safeOffset = Math.max(0, Math.min(offset, totalSize));
    const safeLimit = Math.max(0, limit);
    const end = Math.min(safeOffset + safeLimit, totalSize);
    const content = readResult.content.slice(safeOffset, end);

    return {
      content,
      totalSize,
      offset: safeOffset,
      hasMore: end < totalSize,
      wasTruncated: readResult.wasTruncated,
      processName: session.pty.process,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Kill a PTY process, swallowing any errors (the process may already be dead).
   *
   * Errors are intentionally swallowed rather than logged: `IPtyProcess.kill()`
   * throws when the underlying OS process has already exited, which is the
   * expected state during cleanup and orphan reaping. Logging would produce
   * noise on every normal teardown path without actionable information.
   * @param pty - The PTY process to kill.
   */
  private killPty(pty: IPtyProcess): void {
    try {
      pty.kill();
    } catch {
      /* Process already exited — expected during teardown and orphan cleanup. */
    }
  }

  /**
   * Scan all sessions and tear down any that have exceeded the orphan timeout.
   *
   * Uses a collect-then-delete pattern to avoid mutating the Map during
   * iteration. The deletion phase re-checks each candidate's current state
   * to close the TOCTOU window where `connect()` could re-subscribe a
   * session between collection and deletion.
   */
  private cleanupOrphans(): void {
    const now = Date.now();
    const toCleanup: Array<{ session: PtySession; cleanupable: CleanupableSession }> = [];

    for (const session of this.sessions.values()) {
      const cleanupable: CleanupableSession = {
        supervisorSessionId: session.supervisorSessionId,
        disconnectedAt: session.disconnectedAt,
        dispose: () => session.disposables.forEach((d) => d.dispose()),
        kill: () => this.killPty(session.pty),
      };
      if (shouldCleanupSession(cleanupable, now)) {
        toCleanup.push({ session, cleanupable });
      }
    }

    for (const { session, cleanupable } of toCleanup) {
      // Re-check the session state to close the TOCTOU window: connect() may
      // have re-subscribed the session between the collection and deletion
      // phases, clearing disconnectedAt and incrementing activeSubscriptions.
      const current = this.sessions.get(session.supervisorSessionId);
      if (current === undefined || current.activeSubscriptions > 0 || current.disconnectedAt === null) {
        continue;
      }

      const disconnectedForSec = getDisconnectDuration(cleanupable, now);
      this.logger.info(
        `[PtyRuntime] Cleaning up orphan PTY session: ${session.supervisorSessionId} ` +
          `(disconnected for ${disconnectedForSec}s)`,
      );
      cleanupable.dispose();
      cleanupable.kill();
      this.sessions.delete(session.supervisorSessionId);
      // Orphan cleanup is intentional termination, but emitting onExit with
      // exitCode 1 (rather than a distinct event) is acceptable: the supervisor
      // records the runtime as 'exited' regardless of cause, and no downstream
      // consumer distinguishes natural exit from orphan cleanup.
      this.handlers.onExit({ supervisorSessionId: session.supervisorSessionId, exitCode: 1 });
    }
  }
}
