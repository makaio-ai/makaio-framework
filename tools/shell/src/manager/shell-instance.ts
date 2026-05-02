/**
 * ShellInstance - Wraps an execa subprocess with output buffering.
 *
 * Features:
 * - Spawns shell processes with proper stdin/stdout/stderr handling
 * - Captures output to an OutputBuffer with size limits
 * - Supports input to stdin
 * - Handles timeout and kill operations using tree-kill
 * - Optionally strips ANSI codes from output
 */

import { execa, type ResultPromise, type Options as ExecaOptions } from 'execa';
import stripAnsi from 'strip-ansi';
import treeKill from 'tree-kill';
import { OutputBuffer, getShellCommandArgs, type OutputBufferContent, type OutputBufferStats } from '../utils/index.js';
import type { OutputLine, ShellStatus } from '../types.js';

// =============================================================================
// Types
// =============================================================================

export interface ShellInstanceOptions {
  /** Command to execute */
  command: string;
  /** Shell to use (bash, zsh, powershell, etc.) */
  shell: string;
  /** Working directory */
  cwd: string;
  /** Environment variables */
  env: Record<string, string>;
  /** Preserve ANSI color codes */
  colors: boolean;
  /** Maximum output buffer size in characters */
  maxOutputSize: number;
  /** Timeout in milliseconds */
  timeout: number;
}

type KillSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT';

// =============================================================================
// ShellInstance Class
// =============================================================================

export class ShellInstance {
  public readonly shellId: string;
  public readonly pid: number;
  public readonly shell: string;
  public readonly startTime: number;

  private readonly buffer: OutputBuffer;
  private readonly colors: boolean;
  private readonly subprocess: ResultPromise;

  private exitCode: number | undefined;
  private status: ShellStatus = 'running';
  private _timedOut = false;
  private exitPromise: Promise<void>;

  public constructor(options: ShellInstanceOptions) {
    this.shellId = crypto.randomUUID();
    this.shell = options.shell;
    this.startTime = Date.now();
    this.colors = options.colors;

    // Create output buffer
    this.buffer = new OutputBuffer({
      maxSize: options.maxOutputSize,
      truncateMode: 'tail',
    });

    // Spawn the process
    const execaOptions: ExecaOptions = {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      timeout: options.timeout,
      reject: false,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      buffer: false,
    };

    const shellArgs = getShellCommandArgs(options.shell);
    this.subprocess = execa(options.shell, [...shellArgs, options.command], execaOptions);

    // Get PID - execa guarantees pid is set when process spawns
    this.pid = this.subprocess.pid ?? 0;

    // Set up stream handlers
    this.setupStreamHandlers();

    // Set up exit handling
    this.exitPromise = this.setupExitHandler();
  }

  // ===========================================================================
  // Public Getters
  // ===========================================================================

  /**
   * Whether the process timed out.
   * @returns True if the process exceeded its timeout
   */
  public get timedOut(): boolean {
    return this._timedOut;
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Get the current status of the shell process.
   * @returns Current status ('running' or 'exited')
   */
  public getStatus(): ShellStatus {
    return this.status;
  }

  /**
   * Get the exit code, undefined if still running.
   * @returns Exit code or undefined
   */
  public getExitCode(): number | undefined {
    return this.exitCode;
  }

  /**
   * Get runtime in milliseconds.
   * @returns Duration since shell start in ms
   */
  public getRuntimeMs(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Get buffer statistics.
   * @returns Buffer statistics including sizes and truncation status
   */
  public getBufferStats(): OutputBufferStats {
    return this.buffer.getState();
  }

  /**
   * Get output content with pagination.
   * @param stream - Which stream(s) to retrieve
   * @param offset - Character offset to start from
   * @param limit - Maximum characters to return
   * @returns Output content with pagination metadata
   */
  public getOutput(stream: 'stdout' | 'stderr' | 'both', offset: number, limit: number): OutputBufferContent {
    return this.buffer.getContent(stream, offset, limit);
  }

  /**
   * Get output as lines.
   * @param stream - Which stream(s) to retrieve
   * @returns Array of output lines
   */
  public getLines(stream: 'stdout' | 'stderr' | 'both'): OutputLine[] {
    return this.buffer.getLines(stream);
  }

  /**
   * Send input to stdin.
   * @param input - Text to send
   * @returns Bytes written, 0 if process not running
   */
  public async sendInput(input: string): Promise<number> {
    if (this.status !== 'running' || !this.subprocess.stdin) {
      return 0;
    }

    try {
      this.subprocess.stdin.write(input);
      return Buffer.byteLength(input);
    } catch {
      return 0;
    }
  }

  /**
   * Kill the process.
   * @param signal - Signal to send (default: SIGTERM)
   * @returns True if signal was sent, false if process already exited
   */
  public async kill(signal: KillSignal = 'SIGTERM'): Promise<boolean> {
    if (this.status !== 'running') {
      return false;
    }

    return new Promise((resolve) => {
      treeKill(this.pid, signal, (err) => {
        resolve(!err);
      });
    });
  }

  /**
   * Wait for the process to exit.
   * @returns Promise that resolves when process exits
   */
  public async waitForExit(): Promise<void> {
    return this.exitPromise;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private setupStreamHandlers(): void {
    const { stdout, stderr } = this.subprocess;

    if (stdout) {
      stdout.on('data', (data: Buffer) => {
        const str = this.processOutput(data.toString());
        this.buffer.append('stdout', str);
      });
    }

    if (stderr) {
      stderr.on('data', (data: Buffer) => {
        const str = this.processOutput(data.toString());
        this.buffer.append('stderr', str);
      });
    }
  }

  private processOutput(data: string): string {
    return this.colors ? data : stripAnsi(data);
  }

  private setupExitHandler(): Promise<void> {
    return this.subprocess.then((result) => {
      this.status = 'exited';
      this.exitCode = result.exitCode;
      this._timedOut = result.timedOut;
      this.buffer.flush();
    });
  }
}
