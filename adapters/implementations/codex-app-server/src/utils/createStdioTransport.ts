import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { DeferredPromise } from '@makaio/utils';
import type { ServerNotification, ServerRequest } from '../protocol/generated/index.js';

/**
 * Message received from stdout (notification, response, or server request)
 */
export type StdioMessage = ServerNotification | { id: number; result: unknown } | ServerRequest;

/**
 * Callback invoked when a message is received from stdout
 * @param message - Parsed JSON-RPC message (notification, response, or server request)
 */
type MessageCallback = (message: StdioMessage) => void;

/**
 * Callback invoked when an error occurs
 * @param error - Error describing the failure
 */
type ErrorCallback = (error: Error) => void;

/**
 * Resolve the command used to start the Codex app server.
 * @param binaryPath - Optional resolved managed binary path.
 * @returns Absolute managed binary path, or the PATH-resolved `codex` command.
 */
function resolveSpawnCommand(binaryPath: string | undefined): string {
  if (binaryPath === undefined) {
    return 'codex';
  }

  if (binaryPath.trim() === '' || !path.isAbsolute(binaryPath)) {
    throw new Error('binaryPath must be a non-empty absolute path when provided');
  }

  return binaryPath;
}

/**
 * Transport interface for stdio subprocess communication
 */
export interface StdioTransport {
  /**
   * Send a message to the subprocess via stdin
   * @param message - JSON-RPC message to send (request, response, or notification)
   */
  send(message: object): void;

  /**
   * Close the subprocess and cleanup resources
   */
  close(): void;

  /**
   * Register a callback for message received from stdout
   * @param callback - Function to handle incoming messages
   */
  onMessage(callback: MessageCallback): void;

  /**
   * Register a callback for errors
   * @param callback - Function to handle errors
   */
  onError(callback: ErrorCallback): void;

  /**
   * Settles once the spawned `codex app-server` process has ended, with the exit
   * code it reported or `null` when it was ended by a signal or never ran.
   *
   * The exit was always observed by a listener; what was missing was a way for
   * the caller that requested the close to await that observation instead of
   * settling for "the close call returned".
   *
   * **Settled from `close`, and from `exit` before it when there was one.** A child
   * that never starts — a missing binary, a directory that is not there — emits
   * `error` and `close` and **no** `exit`, so an `exit`-only promise would never
   * settle for a process that never existed: a caller retiring this transport would
   * spend its whole observation budget and then book a `detached` predecessor for
   * nothing. `close` is the one event every spawn attempt reaches, so it is what
   * bounds this promise; `exit` still supplies the code when the process ran. It
   * never rejects — a failure to spawn is reported on the error channel, and this
   * promise answers only "is it over".
   */
  readonly exited: Promise<number | null>;

  /**
   * Whether {@link close} asked this transport to terminate the child before
   * the termination was observed.
   *
   * The marker proves *intent*, never causation: an externally caused exit
   * already under way can deliver its callback after the marker is set, and
   * the exit callback carries only a code. Consumers use it for exactly one
   * decision — whether the resulting exit may be surfaced as a terminal
   * connector error — and never to describe *why* the process ended.
   * @returns `true` once `close()` has requested termination.
   */
  shutdownRequested(): boolean;
}

/**
 * Creates a stdio transport for communicating with codex app-server subprocess
 * @param cwd - Working directory for the subprocess
 * @param env - Environment variables to pass to the subprocess (undefined values are filtered out)
 * @param binaryPath - Absolute path to the codex binary; when omitted, `'codex'` is resolved from PATH
 * @returns Transport interface for sending/receiving messages
 * @throws Error if subprocess fails to spawn
 * @example
 * ```ts
 * const transport = createStdioTransport('/path/to/project', { PATH: process.env.PATH });
 * transport.onMessage((message) => console.log('Received:', message));
 * transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
 * ```
 */
export function createStdioTransport(cwd: string, env: Record<string, unknown>, binaryPath?: string): StdioTransport {
  const command = resolveSpawnCommand(binaryPath);
  // Clean environment variables - filter out undefined values and convert to Record<string, string>
  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined) as Array<[string, string]>,
  );

  // Validate here as well as at the bus contract boundary because this utility
  // is exported and may be called directly by tests or alternate hosts.
  const subprocess = spawn(command, ['app-server'], {
    cwd,
    env: cleanEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let messageCallback: MessageCallback | null = null;
  let errorCallback: ErrorCallback | null = null;

  // Buffer for incomplete JSONL lines
  let buffer = '';

  /**
   * Parse JSONL from stdout and dispatch messages
   */
  subprocess.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line) as StdioMessage;
          messageCallback?.(message);
        } catch {
          // Never retain the malformed line: app-server protocol payloads can
          // contain connector-local authentication material.
          errorCallback?.(new Error('Codex app-server emitted invalid JSONL.'));
        }
      }
    }
  });

  let stderrWarningEmitted = false;
  subprocess.stderr.on('data', () => {
    if (stderrWarningEmitted) return;
    stderrWarningEmitted = true;
    // Child stderr is deliberately suppressed because Codex may include an
    // account-login RPC payload in debug diagnostics.
    console.warn('[codex app-server] stderr output suppressed');
  });

  /**
   * Handle subprocess errors (e.g., codex not found)
   */
  subprocess.on('error', (error: Error) => {
    errorCallback?.(error);
  });

  // Kill-intention marker. Set before the signal is sent so the exit callback
  // that follows can tell an exit this transport asked for from one it did not.
  let closeRequested = false;

  const settleExited = new DeferredPromise<number | null>();
  // Last code an `exit` reported, so the `close` fallback below answers with what
  // was observed rather than with a second, weaker guess. Stays `null` for a
  // process that never ran, which is the same "ended without a code" this promise
  // already reports for a signalled termination.
  let lastExitCode: number | null = null;

  /**
   * Handle subprocess exit
   */
  subprocess.on('exit', (code: number | null) => {
    lastExitCode = code;
    settleExited.resolve(code);

    // A close this transport requested is signalled termination, which arrives
    // as `code === null` and would otherwise be reported as a failure. The exit
    // stays fully observable through `exited`; only its promotion to a terminal
    // connector error is withheld, because the connector asked for it.
    if (closeRequested) return;

    if (code !== 0) {
      const error = new Error(`codex app-server exited with code ${code ?? 'unknown'}`);
      errorCallback?.(error);
    }
  });

  // **The event every spawn attempt reaches.** A child that failed to start emits
  // `error` and `close` and no `exit` at all, so this is what keeps `exited` from
  // hanging for a process that never existed; after a real exit it is a second
  // resolve on an already-settled promise, which is a no-op.
  subprocess.on('close', () => {
    settleExited.resolve(lastExitCode);
  });

  return {
    exited: settleExited.getPromise(),

    shutdownRequested(): boolean {
      return closeRequested;
    },

    /**
     * Send a JSON-RPC message to the subprocess via stdin
     * @param message - JSON-RPC message to send (request, response, or notification)
     */
    send(message: object): void {
      subprocess.stdin.write(JSON.stringify(message) + '\n');
    },

    /**
     * Close the subprocess and cleanup resources
     */
    close(): void {
      // Order matters: the marker must be in place before the signal, because
      // the exit callback can run as soon as the signal is delivered.
      closeRequested = true;
      subprocess.kill();
    },

    /**
     * Register a callback for incoming messages
     * @param callback - Function to handle incoming messages
     */
    onMessage(callback: MessageCallback): void {
      messageCallback = callback;
    },

    /**
     * Register a callback for errors
     * @param callback - Function to handle errors
     */
    onError(callback: ErrorCallback): void {
      errorCallback = callback;
    },
  };
}
