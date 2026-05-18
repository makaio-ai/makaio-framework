/**
 * Shared process-spawn helpers for E2E harnesses.
 *
 * Encapsulates the MAKAIO_PORT stdout-discovery loop, the SIGKILL escalation
 * helper, and the already-exited-child guard used by E2E test harnesses:
 * - `e2e/desktop/spawn-electron.ts`
 * - `e2e/desktop/spawn-electrobun.ts`
 * - `apps/electron/e2e/harness/spawn-runtime.ts`
 * - `apps/cli/e2e/harness/spawn-serve.ts`
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/** Full-line anchor prevents matching log lines that merely contain the token. */
const PORT_PATTERN = /^MAKAIO_PORT=(\d+)$/m;

/**
 * Validate that a parsed port number is a legal TCP port.
 * @param port - Candidate port number.
 * @returns `true` when `port` is an integer in [1, 65535].
 */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

/**
 * Send a signal to a child process and wait for it to exit.
 *
 * If the process does not exit within 10 seconds, escalates to SIGKILL.
 * If the process has already exited, resolves immediately with the stored exit
 * code so callers never hang.
 * @param child - Child process to signal.
 * @param sig - OS signal to send.
 * @param label - Human-readable label for the escalation warning message.
 * @returns Exit code, or `null` when the process was killed by a signal.
 */
function sendSignalToChild(child: ChildProcess, sig: NodeJS.Signals, label: string): Promise<number | null> {
  return new Promise<number | null>((res) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      res(child.exitCode);
      return;
    }
    const escalationTimer = setTimeout(() => {
      console.warn(`[${label}] ${sig} timed out after 10s, escalating to SIGKILL`);
      child.kill('SIGKILL');
    }, 10_000);
    const onExit = (code: number | null): void => {
      clearTimeout(escalationTimer);
      res(code);
    };
    child.once('exit', onExit);
    const killed = child.kill(sig);
    if (!killed) {
      // The child exited between the exitCode/signalCode check above and the
      // kill() call. The 'exit' event will never fire, so clean up and resolve.
      clearTimeout(escalationTimer);
      child.removeListener('exit', onExit);
      res(child.exitCode);
    }
  });
}

/**
 * A handle to a spawned process discovered via `MAKAIO_PORT`.
 */
export interface SpawnedProcess {
  /** The TCP port the bus server bound to (read from stdout). */
  port: number;
  /** PID of the spawned process. */
  pid: number;
  /**
   * Return output captured from stdout and stderr.
   *
   * The buffer is bounded to recent output so long-running processes do not
   * retain unbounded logs.
   * @returns Captured child-process output.
   */
  getOutput(): string;
  /**
   * Wait until the child process emits matching stdout or stderr.
   * @param matcher - String or regular expression to match against captured output.
   * @param timeoutMs - Milliseconds to wait before rejecting.
   * @returns Captured output at the time the matcher is observed.
   */
  waitForOutput(matcher: string | RegExp, timeoutMs: number): Promise<string>;
  /**
   * Send a signal to the process and wait for it to exit.
   *
   * Resolves with the exit code (or `null` when the process was killed by a
   * signal). If the process does not exit within 10 seconds, escalates to
   * `SIGKILL`.
   * @param signal - OS signal to send (e.g. `'SIGTERM'`, `'SIGKILL'`).
   * @returns Exit code or null.
   */
  sendSignal(signal: NodeJS.Signals): Promise<number | null>;
  /**
   * Kill the process with SIGTERM and wait for it to exit.
   * @returns Promise that resolves when the process has exited.
   */
  kill(): Promise<void>;
}

/**
 * Options for {@link spawnAndDiscoverPort}.
 */
export interface SpawnAndDiscoverPortOptions {
  /**
   * Path to the executable (or name on PATH) to spawn.
   */
  cmd: string;
  /**
   * Arguments to pass to the executable.
   */
  args: ReadonlyArray<string>;
  /**
   * Options passed directly to `child_process.spawn`.
   * `stdio` is always overridden to `['ignore', 'pipe', 'pipe']`.
   */
  spawnOptions: Omit<SpawnOptions, 'stdio'>;
  /**
   * Milliseconds to wait for the process to write `MAKAIO_PORT=<n>` to stdout.
   */
  timeoutMs: number;
  /**
   * Short human-readable label used in error and warning messages
   * (e.g. `'startElectronRuntime'`).
   */
  label: string;
}

interface OutputWaiter {
  readonly matcher: string | RegExp;
  readonly resolve: (output: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface OutputCapture {
  append(chunk: Buffer): string;
  get(): string;
  waitFor(matcher: string | RegExp, timeoutMs: number): Promise<string>;
  rejectPending(createError: (matcher: string | RegExp, output: string) => Error): void;
}

const MAX_CAPTURED_OUTPUT_LENGTH = 128_000;

/**
 * Check whether captured output satisfies a waiter matcher.
 * @param output - Captured child-process output.
 * @param matcher - String or regular expression matcher.
 * @returns True when the matcher is present.
 */
function outputMatches(output: string, matcher: string | RegExp): boolean {
  if (typeof matcher === 'string') {
    return output.includes(matcher);
  }
  matcher.lastIndex = 0;
  return matcher.test(output);
}

/**
 * Create a bounded child-process output buffer with waiter support.
 * @param label - Process label used in timeout errors.
 * @returns Output capture helper for spawn harnesses.
 */
function createOutputCapture(label: string): OutputCapture {
  let output = '';
  const waiters: OutputWaiter[] = [];

  const removeWaiter = (waiter: OutputWaiter): void => {
    const index = waiters.indexOf(waiter);
    if (index >= 0) {
      waiters.splice(index, 1);
    }
  };

  const get = (): string => output;

  const append = (chunk: Buffer): string => {
    const text = chunk.toString();
    output += text;
    if (output.length > MAX_CAPTURED_OUTPUT_LENGTH) {
      output = output.slice(-MAX_CAPTURED_OUTPUT_LENGTH);
    }

    for (const waiter of [...waiters]) {
      if (outputMatches(output, waiter.matcher)) {
        clearTimeout(waiter.timer);
        removeWaiter(waiter);
        waiter.resolve(output);
      }
    }
    return text;
  };

  const waitFor = (matcher: string | RegExp, timeoutMs: number): Promise<string> => {
    if (outputMatches(output, matcher)) {
      return Promise.resolve(output);
    }

    return new Promise<string>((resolve, reject) => {
      const waiter: OutputWaiter = {
        matcher,
        resolve,
        reject,
        timer: setTimeout(() => {
          removeWaiter(waiter);
          reject(
            new Error(`[${label}] Timed out after ${timeoutMs}ms waiting for output ${String(matcher)}\n${output}`),
          );
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  };

  const rejectPending = (createError: (matcher: string | RegExp, capturedOutput: string) => Error): void => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(createError(waiter.matcher, output));
    }
  };

  return { append, get, waitFor, rejectPending };
}

/**
 * Parse a port announcement from accumulated stdout.
 * @param stdout - Accumulated stdout before port discovery settles.
 * @param label - Process label used in validation errors.
 * @returns Parsed port, or undefined when no announcement is present yet.
 */
function parsePortAnnouncement(stdout: string, label: string): number | undefined {
  const match = PORT_PATTERN.exec(stdout);
  if (!match) return undefined;

  const parsedPort = parseInt(match[1] ?? '', 10);
  if (!isValidPort(parsedPort)) {
    throw new Error(`[${label}] Invalid port in MAKAIO_PORT announcement: ${match[1]}`);
  }
  return parsedPort;
}

/**
 * Build the public spawned-process handle once port discovery succeeds.
 * @param child - Spawned child process.
 * @param port - Discovered bus port.
 * @param label - Process label used in signal warnings.
 * @param outputCapture - Output capture attached to the child process.
 * @returns Public process handle used by E2E tests.
 */
function createSpawnedProcessHandle(
  child: ChildProcess,
  port: number,
  label: string,
  outputCapture: OutputCapture,
): SpawnedProcess {
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`[${label}] Child process has no PID`);
  }

  const sendSignal = (sig: NodeJS.Signals): Promise<number | null> => sendSignalToChild(child, sig, label);
  const kill = (): Promise<void> => sendSignal('SIGTERM').then(() => undefined);

  return {
    port,
    pid,
    getOutput: outputCapture.get,
    waitForOutput: outputCapture.waitFor,
    sendSignal,
    kill,
  };
}

/**
 * Kill a child process and reject once it has exited.
 * @param child - Spawned child process.
 * @param reject - Promise rejection callback.
 * @param reason - Error message for rejection.
 */
function killAndRejectChild(child: ChildProcess, reject: (error: Error) => void, reason: string): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    reject(new Error(reason));
    return;
  }
  const onExit = (): void => reject(new Error(reason));
  child.once('exit', onExit);
  const killed = child.kill('SIGKILL');
  if (!killed) {
    child.removeListener('exit', onExit);
    reject(new Error(reason));
  }
}

/**
 * Wait until a spawned process announces MAKAIO_PORT.
 * @param child - Spawned child process.
 * @param options - Spawn options containing timeout and label.
 * @param outputCapture - Output capture attached to the child process.
 * @returns Process handle with the discovered port.
 */
function waitForDiscoveredPort(
  child: ChildProcess,
  options: Pick<SpawnAndDiscoverPortOptions, 'timeoutMs' | 'label'>,
  outputCapture: OutputCapture,
): Promise<SpawnedProcess> {
  const { timeoutMs, label } = options;

  return new Promise<SpawnedProcess>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const rejectBeforeSettle = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(reason));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killAndRejectChild(child, reject, `[${label}] Timed out after ${timeoutMs}ms waiting for MAKAIO_PORT`);
    }, timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      const text = outputCapture.append(chunk);
      if (!settled) stderr += text;
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      const text = outputCapture.append(chunk);
      if (settled) return;

      try {
        stdout += text;
        const port = parsePortAnnouncement(stdout, label);
        if (port === undefined) return;
        settled = true;
        clearTimeout(timer);
        resolve(createSpawnedProcessHandle(child, port, label, outputCapture));
      } catch (error) {
        killAndRejectChild(child, reject, error instanceof Error ? error.message : String(error));
      }
    });

    child.on('error', (err) => {
      rejectBeforeSettle(`[${label}] Failed to spawn process: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      const exitSummary = `code ${String(code)} signal ${String(signal)}`;
      outputCapture.rejectPending((matcher, output) => {
        return new Error(
          `[${label}] Process exited with ${exitSummary} before output matched ${String(matcher)}\n${output}`,
        );
      });
      rejectBeforeSettle(`[${label}] Process exited with ${exitSummary} before announcing port\n${stderr}`);
    });
  });
}

/**
 * Spawn a child process and wait for it to announce its port on stdout.
 *
 * Reads `MAKAIO_PORT=<n>` from stdout using a full-line anchor to avoid false
 * positives from log lines that merely contain the token.
 * @param options - Spawn and discovery configuration.
 * @returns A {@link SpawnedProcess} handle with the bound port and signal helpers.
 */
export function spawnAndDiscoverPort(options: SpawnAndDiscoverPortOptions): Promise<SpawnedProcess> {
  const { cmd, args, spawnOptions, timeoutMs, label } = options;
  const outputCapture = createOutputCapture(label);

  const child = spawn(cmd, args as string[], {
    ...spawnOptions,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return waitForDiscoveredPort(child, { timeoutMs, label }, outputCapture);
}
