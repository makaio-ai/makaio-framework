/**
 * Shared process-spawn helpers for E2E harnesses.
 *
 * Encapsulates the MAKAIO_PORT stdout-discovery loop, the SIGKILL escalation
 * helper, and the already-exited-child guard used by E2E test harnesses:
 * - `framework/e2e/desktop/spawn-electron.ts`
 * - `framework/apps/electron/e2e/harness/spawn-runtime.ts`
 * - `framework/apps/cli/e2e/harness/spawn-serve.ts`
 * - `e2e/desktop/spawn-electron.ts`
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

  const child = spawn(cmd, args as string[], {
    ...spawnOptions,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise<SpawnedProcess>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    /**
     * Kill the child and reject only after it has exited, so the process
     * does not leak into the next test.
     *
     * Guards against an already-exited child: if the process exited between
     * the `settled` check and this call, `kill()` would return `false` and
     * the `'exit'` event would never fire, leaving the promise hanging.
     * @param reason - Error message for the rejection.
     */
    const killAndReject = (reason: string): void => {
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
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killAndReject(`[${label}] Timed out after ${timeoutMs}ms waiting for MAKAIO_PORT`);
    }, timeoutMs);

    // Forward child output so test failures are debuggable.
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      // Buffer only pre-settlement; after that, stderr is unneeded and
      // continuing to accumulate would leak memory in long E2E runs.
      if (!settled) stderr += chunk.toString();
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);

      // Once port discovery has settled, stop accumulating; just forward output.
      if (settled) return;

      stdout += chunk.toString();

      const match = PORT_PATTERN.exec(stdout);
      if (match) {
        const parsedPort = parseInt(match[1] ?? '', 10);
        if (!isValidPort(parsedPort)) {
          settled = true;
          stdout = '';
          clearTimeout(timer);
          killAndReject(`[${label}] Invalid port in MAKAIO_PORT announcement: ${match[1]}`);
          return;
        }

        settled = true;
        stdout = '';
        clearTimeout(timer);

        const pid = child.pid;
        if (pid === undefined) {
          killAndReject(`[${label}] Child process has no PID`);
          return;
        }

        const sendSignal = (sig: NodeJS.Signals): Promise<number | null> => sendSignalToChild(child, sig, label);
        const kill = (): Promise<void> => sendSignal('SIGTERM').then(() => undefined);

        resolve({ port: parsedPort, pid, sendSignal, kill });
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`[${label}] Failed to spawn process: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `[${label}] Process exited with code ${String(code)} signal ${String(
            signal,
          )} before announcing port\n${stderr}`,
        ),
      );
    });
  });
}
