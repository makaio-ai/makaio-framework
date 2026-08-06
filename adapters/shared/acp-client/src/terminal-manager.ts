import { spawn, type ChildProcess } from 'node:child_process';
import type * as acp from '@agentclientprotocol/sdk';
import { waitForSpawn, cleanupFailedProcess } from './proc-utils.js';

/**
 * What a terminal process's own end looks like once it has been observed.
 *
 * Named because it is the evidence type the manager hands out, not merely the
 * shape of a promise it keeps: a caller that reports a teardown class for a
 * connector reads exactly this per terminal it spawned.
 */
export interface TerminalExitObservation {
  /** Exit code, or `null` when the process was ended by a signal. */
  readonly exitCode: number | null;
  /** Terminating signal, or `null` when the process exited on its own. */
  readonly signal: string | null;
}

/** Internal state for a managed terminal process. */
interface ManagedTerminal {
  /** The underlying child process */
  readonly process: ChildProcess;
  /** Accumulated output buffer */
  output: string;
  /** Maximum output bytes to retain */
  readonly outputByteLimit: number;
  /** Whether the output has been truncated from the start */
  truncated: boolean;
  /** Exit code set by the `exit` event; undefined until the process exits */
  exitCode: number | null | undefined;
  /** Terminating signal set by the `exit` event; undefined until the process exits */
  signal: string | null | undefined;
  /** True once the `close` event has fired and all I/O streams have been flushed */
  hasExited: boolean;
  /** Promise that resolves with exit code and signal when the process exits */
  readonly exitPromise: Promise<TerminalExitObservation>;
}

/**
 * Manages stateful terminal lifecycles for ACP agents.
 *
 * ACP's terminal protocol is stateful (create → output → wait_for_exit → kill → release),
 * which does not map cleanly to a single request/response. This manager handles direct
 * child_process lifecycle with bounded output buffering.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>();
  /**
   * Ends of terminals already released one at a time, kept until somebody reads
   * them.
   *
   * An agent-initiated `terminal/release` is an ordinary protocol act, so it books
   * nothing and caps nothing — but it does end a process this runtime spawned, and
   * a shutdown that reports a class for this connector is answerable for that end
   * too. Dropping the exit promise on release let a later close claim `exited` for a
   * kill nobody ever watched land; keeping it makes the same close either *observe*
   * the end — the usual case, since the SIGKILL is long since reaped by then — or
   * report honestly that it did not.
   *
   * Bounded by the number of releases between two shutdown collections, and each
   * collection empties it: what is retained is a settled promise per released
   * terminal, not the terminal.
   */
  private readonly retiredExits: Array<Promise<TerminalExitObservation>> = [];
  private readonly baseEnv: Readonly<Record<string, string>>;
  private readonly scrubEnvVars: ReadonlySet<string>;
  private readonly spawnTimeoutMs: number;
  private nextId = 0;

  /**
   * Create a terminal manager bound to one finalized connector environment.
   * @param options - Sanitized base environment, variables that terminal requests
   *   may not restore, and the budget a terminal spawn may take
   */
  public constructor(options: {
    readonly baseEnv: Readonly<Record<string, string>>;
    readonly scrubEnvVars?: readonly string[];
    readonly spawnTimeoutMs: number;
  }) {
    this.spawnTimeoutMs = options.spawnTimeoutMs;
    this.scrubEnvVars = new Set(options.scrubEnvVars ?? []);
    this.baseEnv = Object.freeze(
      Object.fromEntries(Object.entries(options.baseEnv).filter(([name]) => !this.scrubEnvVars.has(name))),
    );
  }

  /**
   * Creates a new terminal subprocess.
   * @param params - ACP create terminal request
   * @returns Terminal ID for subsequent operations
   */
  public async createTerminal(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    const terminalId = `terminal-${(++this.nextId).toString()}`;
    const outputByteLimit = params.outputByteLimit ?? 1024 * 1024; // 1 MiB default

    const requestEnv = (params.env ?? [])
      .filter(({ name }) => !this.scrubEnvVars.has(name))
      .map(({ name, value }) => [name, value] as const);
    const env = Object.fromEntries([...Object.entries(this.baseEnv), ...requestEnv]);

    const proc = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? undefined,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // **Observed before it is waited for.** A fired `exit` or `close` is not
    // replayed to a listener that arrives afterwards, so a terminal whose command
    // ends while this function is still awaiting something would leave
    // `exitPromise` unsettled forever — and since connector shutdown now *awaits*
    // these promises as its exit evidence, an unsettled one costs the whole
    // observation budget and then reports `detached` for a process that died long
    // ago. Installing the observation before the first await makes that
    // impossible by construction instead of by there happening to be no
    // suspension point in between; it is the ordering `createAcpConnection` uses
    // for the same reason. The same applies to the output listeners: bytes a fast
    // command already wrote are equally unrepeatable.
    const terminal: ManagedTerminal = {
      process: proc,
      output: '',
      outputByteLimit,
      truncated: false,
      exitCode: undefined,
      signal: undefined,
      hasExited: false,
      exitPromise: new Promise<TerminalExitObservation>((resolve) => {
        proc.on('exit', (code, exitSignal) => {
          terminal.exitCode = code;
          terminal.signal = exitSignal ?? null;
        });
        proc.on('close', () => {
          terminal.hasExited = true;
          resolve({ exitCode: terminal.exitCode ?? null, signal: terminal.signal ?? null });
        });
      }),
    };

    const appendOutput = (chunk: Buffer) => {
      terminal.output += chunk.toString('utf-8');
      const byteLength = Buffer.byteLength(terminal.output, 'utf-8');
      if (byteLength > terminal.outputByteLimit) {
        const bytes = Buffer.from(terminal.output, 'utf-8');
        let start = bytes.length - terminal.outputByteLimit;
        while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
          start += 1;
        }
        terminal.output = bytes.subarray(start).toString('utf-8');
        terminal.truncated = true;
      }
    };

    proc.stdout?.on('data', appendOutput);
    proc.stderr?.on('data', appendOutput);

    try {
      await waitForSpawn(proc, { timeoutMs: this.spawnTimeoutMs });
    } catch (error) {
      // Registered only after the spawn is proven: a terminal the caller never
      // received an ID for must not be reachable by ID, and must not be handed
      // back by `releaseAll` as evidence.
      await cleanupFailedProcess(proc);
      throw error;
    }

    this.terminals.set(terminalId, terminal);

    return { terminalId };
  }

  /**
   * Gets the current output of a terminal without waiting for it to exit.
   * @param params - ACP terminal output request
   * @returns Current buffered output and truncation status
   */
  public async getOutput(params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> {
    const terminal = this.requireTerminal(params.terminalId);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.hasExited && {
        exitStatus: {
          exitCode: terminal.exitCode ?? null,
          signal: terminal.signal ?? null,
        },
      }),
    };
  }

  /**
   * Waits for a terminal process to exit.
   * @param params - ACP wait for exit request
   * @returns Exit code and terminating signal
   */
  public async waitForExit(params: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse> {
    const terminal = this.requireTerminal(params.terminalId);
    const { exitCode, signal } = await terminal.exitPromise;
    return {
      exitCode: exitCode ?? undefined,
      signal: signal ?? undefined,
    };
  }

  /**
   * Kills a terminal process without releasing it.
   *
   * The terminal remains valid after this call, allowing callers to retrieve
   * final output before releasing.
   * @param params - ACP kill terminal request
   * @returns Empty response object
   */
  public async killTerminal(params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse> {
    const terminal = this.requireTerminal(params.terminalId);
    terminal.process.kill('SIGTERM');
    return {};
  }

  /**
   * Releases a terminal, killing the process and keeping its end to be read.
   *
   * After this call the terminal ID is no longer valid. The release itself does not
   * wait — an agent asked for it and is owed a prompt response — but the process's
   * exit promise moves to {@link retiredExits} rather than being dropped, so the
   * connector shutdown that later reports a class for this runtime collects this
   * kill's end alongside the ends of the terminals still open. That is the whole of
   * what this release owes: it is a normal protocol act and books no generation, so
   * it can cap no class on its own — an end already landed is simply *observed* by
   * the collection instead of being assumed.
   * @param params - ACP release terminal request
   * @returns Empty response object
   */
  public async releaseTerminal(params: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (terminal) {
      terminal.process.kill('SIGKILL');
      this.terminals.delete(params.terminalId);
      this.retiredExits.push(terminal.exitPromise);
    }
    return {};
  }

  /**
   * Kills and removes all managed terminals, handing back their ends to watch.
   *
   * Called during connector shutdown. The kill is a signal, not an observation:
   * these are processes this runtime spawned, so their ends are evidence its
   * teardown is entitled to — and evidence it already holds, since every terminal
   * carries its own exit promise from the moment it was created. Returning them is
   * what lets the caller decide the honest class instead of assuming a SIGKILL
   * landed.
   *
   * **Terminals released one at a time count too.** An agent-initiated
   * `terminal/release` already killed its process and kept its end
   * ({@link retiredExits}); those ends belong to this runtime's shutdown just as
   * much as the ones killed here, because the class the caller reports covers every
   * process this runtime spawned — not only the ones that happened to still be open
   * at the end. Consuming the retained ends empties the list, so a second call
   * reports each end once.
   *
   * The manager itself does not wait: a shutdown must not be held by a terminal,
   * and the caller is the party with a budget and a class to report.
   * @returns One exit observation per terminal this runtime ended and nobody has
   *   read yet — the ends released earlier first, then the ones killed here.
   */
  public releaseAll(): ReadonlyArray<Promise<TerminalExitObservation>> {
    const released: Array<Promise<TerminalExitObservation>> = this.retiredExits.splice(0);
    for (const [id, terminal] of this.terminals) {
      terminal.process.kill('SIGKILL');
      released.push(terminal.exitPromise);
      this.terminals.delete(id);
    }
    return released;
  }

  /**
   * Returns a managed terminal by ID, throwing if not found.
   * @param terminalId - Terminal identifier assigned at creation time
   * @returns The managed terminal state
   */
  private requireTerminal(terminalId: string): ManagedTerminal {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    return terminal;
  }
}
