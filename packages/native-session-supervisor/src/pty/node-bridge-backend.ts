/**
 * Node-Bridge PTY Backend
 *
 * An {@link IPtyBackend} implementation for Bun hosts where the `node-pty`
 * native addon is unavailable. It lazily spawns a single Node.js child process
 * (`pty-bridge.cjs`) that manages PTY sessions and communicates via
 * newline-delimited JSON-RPC over stdio.
 *
 * The bridge is started on the first `spawn()` call and shared across all
 * subsequent sessions. `dispose()` kills the bridge and clears every session.
 * @packageDocumentation
 */

import * as path from 'node:path';
import * as readline from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { IPtyBackend, IPtyProcess, IPtySpawnOptions } from './types.js';

// ── Protocol types ────────────────────────────────────────────────────────────

/** Commands sent from the host → bridge (stdin). */
type BridgeCommand =
  | { id: number; cmd: 'spawn'; file: string; args: string[]; options: IPtySpawnOptions }
  | { id: number; cmd: 'input'; ptyId: number; data: string }
  | { id: number; cmd: 'resize'; ptyId: number; cols: number; rows: number }
  | { id: number; cmd: 'kill'; ptyId: number; signal?: string };

/** Events received from bridge → host (stdout). */
type BridgeEvent =
  | { id: number; ptyId: number; event: 'spawned'; pid: number; process: string }
  | { ptyId: number; event: 'data'; data: string }
  | { ptyId: number; event: 'exit'; exitCode: number; signal: number }
  | { id: number; event: 'error'; message: string };

// ── Listener types ────────────────────────────────────────────────────────────

type DataListener = (data: string) => void;
type ExitListener = (e: { exitCode: number; signal?: number }) => void;

// ── BridgePtyProcess ─────────────────────────────────────────────────────────

/**
 * A handle to a single PTY session managed by the bridge subprocess.
 *
 * Implements {@link IPtyProcess} by forwarding operations through the bridge's
 * JSON-RPC protocol. Data and exit events are pushed by {@link NodeBridgeBackend}
 * when they arrive from the bridge's stdout.
 */
class BridgePtyProcess implements IPtyProcess {
  /** {@inheritdoc} */
  public readonly pid: number;
  /** {@inheritdoc} */
  public readonly process: string;

  private _cols: number;
  private _rows: number;
  private closed = false;

  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();

  /**
   * @param pid - OS PID of the PTY child inside the bridge.
   * @param processName - Name of the running executable.
   * @param ptyId - Bridge-internal PTY identifier.
   * @param initialCols - Initial column count.
   * @param initialRows - Initial row count.
   * @param sendCommand - Callback that writes a command to the bridge stdin.
   */
  public constructor(
    pid: number,
    processName: string,
    private readonly ptyId: number,
    initialCols: number,
    initialRows: number,
    private readonly sendCommand: (cmd: BridgeCommand) => void,
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
   * Write raw input to the PTY. The data is base64-encoded before sending
   * over the JSON-RPC channel.
   *
   * PTY traffic is tunneled through JSON as a byte-preserving "binary string":
   * latin1 maps code points 0–255 directly to bytes, unlike utf8 which would
   * re-encode multi-byte characters and corrupt escape sequences / raw output.
   * @param data - The string to write.
   */
  public write(data: string): void {
    if (this.closed) return;
    // id=0 — fire-and-forget; the bridge does not reply to input commands.
    this.sendCommand({
      id: 0,
      cmd: 'input',
      ptyId: this.ptyId,
      data: Buffer.from(data, 'latin1').toString('base64'),
    });
  }

  /**
   * Resize the terminal.
   * @param cols - New column width.
   * @param rows - New row height.
   */
  public resize(cols: number, rows: number): void {
    if (this.closed) return;
    this._cols = cols;
    this._rows = rows;
    this.sendCommand({ id: 0, cmd: 'resize', ptyId: this.ptyId, cols, rows });
  }

  /**
   * Kill the PTY process.
   * @param signal - Signal name. Defaults to `'SIGHUP'`.
   */
  public kill(signal?: string): void {
    if (this.closed) return;
    this.sendCommand({ id: 0, cmd: 'kill', ptyId: this.ptyId, signal });
  }

  /**
   * Register a data listener.
   * @param listener - Callback invoked with each decoded output chunk.
   * @returns A disposable that removes the listener.
   */
  public onData(listener: DataListener): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  /**
   * Register an exit listener.
   * @param listener - Callback invoked when the PTY exits.
   * @returns A disposable that removes the listener.
   */
  public onExit(listener: ExitListener): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  /**
   * Push a decoded data chunk to all registered data listeners.
   *
   * Called by {@link NodeBridgeBackend} when a `data` event arrives from the bridge.
   * @param data - Decoded terminal output string.
   */
  public pushData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  /**
   * Push an exit event to all registered exit listeners.
   *
   * Called by {@link NodeBridgeBackend} when an `exit` event arrives from the bridge.
   * @param exitCode - Process exit code.
   * @param signal - OS signal number (0 means no signal).
   */
  public pushExit(exitCode: number, signal: number): void {
    if (this.closed) return;
    this.closed = true;
    const signalArg = signal !== 0 ? signal : undefined;
    for (const listener of this.exitListeners) {
      listener({ exitCode, signal: signalArg });
    }
  }
}

// ── Subprocess abstraction ────────────────────────────────────────────────────

/**
 * Minimal bridge process surface used by {@link NodeBridgeBackend}.
 *
 * Only the operations actually invoked by the backend are declared, keeping
 * the interface narrow and easy to satisfy from both Bun and Node runtimes.
 */
interface BridgeProcess {
  /**
   * Write a UTF-8 string to the bridge's stdin.
   * @param text - Text to write (typically a newline-terminated JSON line).
   */
  writeStdin(text: string): void;

  /** Node.js `Readable` connected to the bridge's stdout. */
  readonly stdout: NodeJS.ReadableStream;

  /**
   * Kill the bridge subprocess.
   * @param signal - Signal name (e.g. `'SIGTERM'`).
   */
  kill(signal?: string): void;
}

// ── Minimal Bun type surface ──────────────────────────────────────────────────

/**
 * Subset of Bun's `Subprocess` interface used by this module.
 *
 * Duck-typed so that `bun-types` is not a required dependency.
 */
interface BunSubprocess {
  /**
   * Writable stream connected to the subprocess's stdin when spawned with
   * `stdin: 'pipe'`.
   */
  readonly stdin: WritableStream<Uint8Array>;
  /**
   * Web ReadableStream connected to the subprocess's stdout when spawned with
   * `stdout: 'pipe'`.
   */
  readonly stdout: ReadableStream<Uint8Array>;
  /**
   * Kill the subprocess.
   * @param signal - Numeric POSIX signal number.
   */
  kill(signal?: number): void;
}

/**
 * Subset of the `Bun` global used by this module.
 *
 * Duck-typed to avoid a hard dependency on `bun-types`.
 */
interface BunGlobal {
  /**
   * Spawn a subprocess.
   * @param cmd - Command and arguments array.
   * @param options - Spawn options.
   */
  spawn(cmd: string[], options: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'inherit' }): BunSubprocess;
  /**
   * Resolve an executable on PATH when available in the Bun host.
   * @param command - Executable name to resolve.
   * @returns Absolute executable path, or `null` when not found.
   */
  which?(command: string): string | null;
}

/**
 * Narrow `globalThis` to the Bun runtime surface when `Bun` is present.
 *
 * Returns `null` when not running under Bun.
 * @returns The typed `Bun` global, or `null` on Node.js.
 */
function getBunGlobal(): BunGlobal | null {
  const g = globalThis as Record<string, unknown>;
  const maybeGlobal = g['Bun'];
  if (typeof maybeGlobal === 'object' && maybeGlobal !== null) {
    return maybeGlobal as BunGlobal;
  }
  return null;
}

/**
 * Adapt a Bun Web `ReadableStream<Uint8Array>` to a Node.js `Readable`.
 *
 * `readline` requires a Node.js Readable; Bun's stdout is a Web ReadableStream.
 * The reader is pulled incrementally to avoid buffering the entire output.
 * @param webReadable - Bun's readable stdout stream.
 * @returns A Node.js `Readable` that mirrors the Bun stream.
 */
function adaptBunStdout(webReadable: ReadableStream<Uint8Array>): NodeJS.ReadableStream {
  const reader = webReadable.getReader();

  return new Readable({
    read() {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            this.push(null);
          } else {
            this.push(Buffer.from(value));
          }
        })
        .catch((err: unknown) => {
          this.destroy(err instanceof Error ? err : new Error(String(err)));
        });
    },
  });
}

// ── Bridge path resolution ────────────────────────────────────────────────────

/**
 * Resolve the absolute path to the bridge CJS script relative to this module.
 * @returns Absolute filesystem path to `pty-bridge.cjs`.
 */
function resolveBridgePath(): string {
  // `__dirname` is not available in ESM; derive the directory from `import.meta.url`.
  // `fileURLToPath` is used instead of `.pathname` to handle Windows paths correctly
  // (`.pathname` produces a spurious leading `/` on Windows, e.g. `/C:/Users/...`).
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(selfDir, './bridge/pty-bridge.cjs');
}

/**
 * Resolve the Node.js executable used to host the PTY bridge subprocess.
 *
 * Node runtimes reuse `process.execPath` so the bridge inherits the exact same
 * Node binary. Bun hosts need an explicit Node executable because the bridge
 * depends on `node-pty`, which cannot run on Bun itself.
 * @param bun - Typed Bun global when running under Bun, or `null` on Node.js.
 * @returns Absolute or PATH-resolved Node executable command.
 */
function resolveNodeExecutable(bun: BunGlobal | null): string {
  if (bun === null) {
    return process.execPath;
  }

  const configured = process.env['MAKAIO_NODE_EXECUTABLE']?.trim();
  if (configured) {
    return configured;
  }

  const discovered = bun.which?.('node')?.trim();
  if (discovered) {
    return discovered;
  }

  throw new Error(
    'NodeBridgeBackend requires MAKAIO_NODE_EXECUTABLE or a discoverable node executable on PATH when running under Bun.',
  );
}

// ── Bridge subprocess spawning ────────────────────────────────────────────────

/**
 * Spawn the bridge subprocess via Bun's native `Bun.spawn`.
 * @param bun - Typed reference to the Bun global.
 * @param bridgePath - Absolute path to `pty-bridge.cjs`.
 * @returns A {@link BridgeProcess} wrapping the Bun subprocess.
 */
function spawnViaBun(bun: BunGlobal, bridgePath: string): BridgeProcess {
  const proc = bun.spawn([resolveNodeExecutable(bun), bridgePath], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const encoder = new TextEncoder();
  const stdinWriter = proc.stdin.getWriter();

  return {
    writeStdin: (text: string) => {
      stdinWriter.write(encoder.encode(text)).catch(() => {
        // Ignore write errors — the close handler will surface them.
      });
    },
    stdout: adaptBunStdout(proc.stdout),
    // This kills the bridge subprocess itself. PTY-session signals are forwarded
    // over the bridge protocol, so backend lifecycle only needs SIGTERM here.
    kill: (signal?: string) => proc.kill(signal === 'SIGTERM' ? 15 : 9),
  };
}

/**
 * Spawn the bridge subprocess via Node's `child_process.spawn`.
 *
 * Used when running under Node.js (tests or Node-only deployments).
 * @param bridgePath - Absolute path to `pty-bridge.cjs`.
 * @returns A {@link BridgeProcess} wrapping the Node child process.
 */
async function spawnViaNode(bridgePath: string): Promise<BridgeProcess> {
  const { spawn } = await import('node:child_process');
  const child = spawn(resolveNodeExecutable(null), [bridgePath], { stdio: ['pipe', 'pipe', 'inherit'] });

  return {
    writeStdin: (text: string) => {
      child.stdin.write(text);
    },
    stdout: child.stdout as NodeJS.ReadableStream,
    kill: (signal?: string) => child.kill((signal ?? 'SIGTERM') as NodeJS.Signals),
  };
}

/**
 * Spawn the bridge subprocess, preferring `Bun.spawn` when available.
 * @param bridgePath - Absolute path to `pty-bridge.cjs`.
 * @returns A {@link BridgeProcess} wrapping the bridge.
 */
async function spawnBridgeProcess(bridgePath: string): Promise<BridgeProcess> {
  const bun = getBunGlobal();
  if (bun !== null) {
    return spawnViaBun(bun, bridgePath);
  }
  return spawnViaNode(bridgePath);
}

// ── NodeBridgeBackend ─────────────────────────────────────────────────────────

/** Pending "spawn" response bookkeeping. */
interface PendingSpawn {
  resolve: (proc: BridgePtyProcess) => void;
  reject: (err: Error) => void;
  cols: number;
  rows: number;
}

/**
 * PTY backend that delegates to a Node.js bridge subprocess.
 *
 * Designed for Bun hosts where `node-pty`'s native addon is unavailable.
 * The bridge process is started lazily on the first `spawn()` call and is
 * shared across all sessions for the lifetime of the backend.
 */
export class NodeBridgeBackend implements IPtyBackend {
  private bridge: BridgeProcess | null = null;
  private rl: readline.Interface | null = null;

  /**
   * Set to `true` by `dispose()` to prevent any subsequent `ensureBridge()` or
   * `spawn()` call from starting a new bridge after teardown has begun.
   */
  private disposed = false;

  /**
   * In-flight bridge startup promise. Shared by concurrent `ensureBridge()`
   * callers so only one subprocess is ever started.
   */
  private bridgeStarting: Promise<void> | null = null;

  /** Pending "spawn" responses, keyed by request id. */
  private readonly pendingSpawns = new Map<number, PendingSpawn>();

  /** Active PTY sessions keyed by bridge ptyId. */
  private readonly sessions = new Map<number, BridgePtyProcess>();

  private nextCmdId = 1;

  /**
   * Ensure the bridge subprocess is running, starting it if necessary.
   *
   * Concurrent callers share a single start promise to prevent multiple
   * bridge processes from being spawned.
   * @returns A promise that resolves once the bridge is ready.
   */
  private ensureBridge(): Promise<void> {
    if (this.bridge !== null) return Promise.resolve();
    if (this.bridgeStarting !== null) return this.bridgeStarting;

    this.bridgeStarting = (async () => {
      try {
        const bridgePath = resolveBridgePath();
        const spawned = await spawnBridgeProcess(bridgePath);

        // Guard against `dispose()` being called while the subprocess was starting.
        // If disposal raced with this await, kill the just-spawned process immediately.
        if (this.disposed) {
          spawned.kill('SIGTERM');
          return;
        }

        this.bridge = spawned;

        this.rl = readline.createInterface({ input: this.bridge.stdout, crlfDelay: Infinity });
        this.rl.on('line', (line) => this.handleLine(line));
        this.rl.on('close', () => this.handleBridgeClosed());
      } finally {
        this.bridgeStarting = null;
      }
    })();

    return this.bridgeStarting;
  }

  /**
   * Parse and dispatch a single newline-delimited JSON event from the bridge.
   * @param line - Raw text line from bridge stdout.
   */
  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: BridgeEvent;
    try {
      event = JSON.parse(trimmed) as BridgeEvent;
    } catch {
      return; // Malformed line — ignore silently.
    }

    this.dispatch(event);
  }

  /**
   * Route a parsed bridge event to the appropriate handler.
   * @param event - Typed event from the bridge.
   */
  private dispatch(event: BridgeEvent): void {
    switch (event.event) {
      case 'spawned': {
        const pending = this.pendingSpawns.get(event.id);
        if (!pending) return;
        this.pendingSpawns.delete(event.id);

        const proc = new BridgePtyProcess(event.pid, event.process, event.ptyId, pending.cols, pending.rows, (cmd) =>
          this.sendCommand(cmd),
        );
        this.sessions.set(event.ptyId, proc);
        pending.resolve(proc);
        return;
      }

      case 'error': {
        const pending = this.pendingSpawns.get(event.id);
        if (pending) {
          this.pendingSpawns.delete(event.id);
          pending.reject(new Error(event.message));
        }
        return;
      }

      case 'data': {
        const proc = this.sessions.get(event.ptyId);
        if (!proc) return;
        const decoded = Buffer.from(event.data, 'base64').toString('latin1');
        proc.pushData(decoded);
        return;
      }

      case 'exit': {
        const proc = this.sessions.get(event.ptyId);
        if (!proc) return;
        this.sessions.delete(event.ptyId);
        proc.pushExit(event.exitCode, event.signal);
        return;
      }
    }
  }

  /**
   * Handle the bridge process closing its stdout (crash or graceful shutdown).
   *
   * Rejects all pending spawns and synthesizes exit events for all active
   * sessions so that the PTY runtime can clean up its session records.
   */
  private handleBridgeClosed(): void {
    this.bridge = null;
    this.rl = null;

    for (const [, pending] of this.pendingSpawns) {
      pending.reject(new Error('PTY bridge process closed unexpectedly'));
    }
    this.pendingSpawns.clear();

    for (const [, proc] of this.sessions) {
      proc.pushExit(1, 0);
    }
    this.sessions.clear();
  }

  /**
   * Serialize and write a command to the bridge's stdin.
   * @param cmd - The command to send.
   */
  private sendCommand(cmd: BridgeCommand): void {
    if (!this.bridge) return;
    try {
      this.bridge.writeStdin(`${JSON.stringify(cmd)}\n`);
    } catch {
      // Bridge has crashed — the close handler will clean up.
    }
  }

  /**
   * Spawn a new PTY session via the bridge.
   *
   * Starts the bridge subprocess on the first call. Resolves once the bridge
   * confirms the OS process is running (i.e. `pid` is known).
   * @param file - Executable path or name.
   * @param args - Argument list.
   * @param options - Terminal dimensions, cwd, env, and terminal name.
   * @returns Resolves with the running PTY process handle.
   */
  public async spawn(file: string, args: string[], options: IPtySpawnOptions): Promise<IPtyProcess> {
    if (this.disposed) {
      return Promise.reject(new Error('NodeBridgeBackend has been disposed'));
    }
    await this.ensureBridge();
    if (this.disposed || this.bridge === null) {
      return Promise.reject(new Error('NodeBridgeBackend is not available'));
    }

    const id = this.nextCmdId++;
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;

    return new Promise<IPtyProcess>((resolve, reject) => {
      this.pendingSpawns.set(id, { resolve, reject, cols, rows });
      this.sendCommand({ id, cmd: 'spawn', file, args, options });
    });
  }

  /**
   * Dispose the backend: close the bridge subprocess and cancel all sessions.
   *
   * Pending spawns are rejected immediately. Active sessions receive a synthetic
   * exit event so that their listeners can clean up.
   * @returns Resolves when teardown is complete.
   */
  public async dispose(): Promise<void> {
    // Mark as disposed immediately so that any concurrent `ensureBridge()` or
    // `spawn()` call that resumes after an await sees the flag and aborts.
    this.disposed = true;

    // Reject pending spawns before clearing so callers don't hang.
    for (const [, pending] of this.pendingSpawns) {
      pending.reject(new Error('NodeBridgeBackend disposed'));
    }
    this.pendingSpawns.clear();

    // Synthesize exits for active sessions.
    for (const [, proc] of this.sessions) {
      proc.pushExit(1, 0);
    }
    this.sessions.clear();

    // Kill the bridge subprocess BEFORE closing the readline interface.
    // `rl.close()` fires the 'close' event synchronously, which invokes
    // `handleBridgeClosed()` and nulls out `this.bridge`. Saving a local
    // reference and killing it first guarantees the subprocess is always
    // terminated regardless of that handler's side-effect.
    const bridge = this.bridge;
    this.bridge = null;
    this.bridgeStarting = null;

    bridge?.kill('SIGTERM');

    this.rl?.close();
    this.rl = null;
  }
}
