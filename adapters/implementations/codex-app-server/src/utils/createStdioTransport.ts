import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { decodeJsonlChunk, notifyListeners } from '@makaio/subprocess';
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
 * Callback invoked when the transport fails: the subprocess reported an error,
 * exited unexpectedly, or a message consumer threw. Malformed stdout lines are
 * not failures and never reach it.
 * @param error - Error describing the failure
 */
type ErrorCallback = (error: Error) => void;

/**
 * Report a transport failure to every error subscriber. A subscriber that
 * throws is logged by name only, because a failure can carry app-server
 * protocol content, and does not keep later subscribers from the failure.
 * @param callbacks - Error subscribers of one transport
 * @param error - Failure to report
 */
function reportTransportFailure(callbacks: ReadonlySet<ErrorCallback>, error: Error): void {
  notifyListeners(callbacks, error, (thrown) => {
    console.error(
      `[codex app-server] transport error subscriber threw ${thrown instanceof Error ? thrown.name : typeof thrown}`,
    );
  });
}

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
   * Subscribe to messages received from stdout. Every subscriber receives every
   * message; a subscriber that throws is reported as a transport failure.
   * @param callback - Function to handle incoming messages
   * @returns Function that removes this subscription
   */
  onMessage(callback: MessageCallback): () => void;

  /**
   * Subscribe to transport failures (see {@link ErrorCallback}). Every
   * subscriber observes every failure: the JSON-RPC client rejects its in-flight
   * requests with it while the connector terminates on the same failure.
   * @param callback - Function to handle transport failures
   * @returns Function that removes this subscription
   */
  onError(callback: ErrorCallback): () => void;

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
   * A `close()` that arrives after the child's end was observed does not set it:
   * that exit was already classified, as unrequested if it was reported.
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

  const messageCallbacks = new Set<MessageCallback>();
  const errorCallbacks = new Set<ErrorCallback>();
  const reportFailure = (error: Error): void => reportTransportFailure(errorCallbacks, error);

  // Buffer for incomplete JSONL lines
  let buffer = '';

  /**
   * Parse JSONL from stdout and dispatch messages
   */
  subprocess.stdout.on('data', (chunk: Buffer) => {
    const result = decodeJsonlChunk(chunk.toString('utf-8'), buffer);
    buffer = result.remaining;

    for (const message of result.messages) {
      // A throwing consumer is a connector fault, not malformed input.
      notifyListeners(messageCallbacks, message as StdioMessage, (error) => {
        reportFailure(error instanceof Error ? error : new Error(String(error)));
      });
    }

    // A malformed line names no request and leaves app-server running, so it is
    // a diagnostic, not a connector failure. The decoder only counts such lines:
    // app-server protocol payloads can contain connector-local authentication
    // material.
    if (result.malformedLineCount > 0) {
      console.warn(`[codex app-server] dropped ${result.malformedLineCount} malformed JSONL line(s)`);
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
    reportFailure(error);
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

    // Every exit this transport did not request is terminal, whatever its code:
    // the connection is gone, so in-flight requests can never be answered. A
    // clean code 0 is no exception — malformed lines are non-fatal, so this exit
    // is the only signal left that would settle pending RPCs before their timeout.
    // Reported on `exit`, not on the later `close` the generic JSONL transport in
    // `@makaio/subprocess` waits for: app-server is a long-lived server, so an
    // exit it was not asked for is a death rather than a final answer still in
    // the pipe, and `close` waits on every holder of its stdout, so a descendant
    // that inherited the pipe would hide that death indefinitely.
    reportFailure(new Error(`codex app-server exited with code ${code ?? 'unknown'}`));
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
      //
      // Once the child's end is observed (`exitCode`/`signalCode`, set before
      // `exit` is emitted), a later `close()` no longer sets the marker, so the
      // exit that an error subscriber's shutdown follows is not re-read as
      // requested. A close issued while the child is still alive is not
      // distinguishable from a requested one here.
      //
      // TODO(FACT-459): a failure-driven `close()` while the child is still alive
      // sets the marker and finalises the exit a second time. Two cases remain:
      // a message subscriber that throws while the child is alive, and a spawn
      // failure under Bun, which leaves `exitCode` null during `error` (Node sets
      // -2). The marker records only that `close()` ran, not who asked for it, so
      // it cannot tell these apart from a requested close. The redesign replaces
      // the marker with intent recorded by the stop owner.
      if (subprocess.exitCode === null && subprocess.signalCode === null) {
        closeRequested = true;
      }
      subprocess.kill();
    },

    /**
     * Subscribe to incoming messages
     * @param callback - Function to handle incoming messages
     * @returns Function that removes this subscription
     */
    onMessage(callback: MessageCallback): () => void {
      messageCallbacks.add(callback);
      return () => {
        messageCallbacks.delete(callback);
      };
    },

    /**
     * Subscribe to transport failures
     * @param callback - Function to handle transport failures
     * @returns Function that removes this subscription
     */
    onError(callback: ErrorCallback): () => void {
      errorCallbacks.add(callback);
      return () => {
        errorCallbacks.delete(callback);
      };
    },
  };
}
