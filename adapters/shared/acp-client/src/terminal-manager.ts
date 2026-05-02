import { spawn, type ChildProcess } from 'node:child_process';
import type * as acp from '@agentclientprotocol/sdk';
import { waitForSpawn, cleanupFailedProcess } from './proc-utils.js';

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
  readonly exitPromise: Promise<{ exitCode: number | null; signal: string | null }>;
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
  private nextId = 0;

  /**
   * Creates a new terminal subprocess.
   * @param params - ACP create terminal request
   * @returns Terminal ID for subsequent operations
   */
  public async createTerminal(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    const terminalId = `terminal-${(++this.nextId).toString()}`;
    const outputByteLimit = params.outputByteLimit ?? 1024 * 1024; // 1 MiB default

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (params.env) {
      for (const envVar of params.env) {
        env[envVar.name] = envVar.value;
      }
    }

    const proc = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? undefined,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      await waitForSpawn(proc);
    } catch (error) {
      await cleanupFailedProcess(proc);
      throw error;
    }

    const terminal: ManagedTerminal = {
      process: proc,
      output: '',
      outputByteLimit,
      truncated: false,
      exitCode: undefined,
      signal: undefined,
      hasExited: false,
      exitPromise: new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
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
   * Releases a terminal, killing the process and freeing all associated resources.
   *
   * After this call the terminal ID is no longer valid.
   * @param params - ACP release terminal request
   * @returns Empty response object
   */
  public async releaseTerminal(params: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (terminal) {
      terminal.process.kill('SIGKILL');
      this.terminals.delete(params.terminalId);
    }
    return {};
  }

  /**
   * Kills and removes all managed terminals.
   *
   * Should be called during connector shutdown to prevent resource leaks.
   */
  public releaseAll(): void {
    for (const [id, terminal] of this.terminals) {
      terminal.process.kill('SIGKILL');
      this.terminals.delete(id);
    }
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
