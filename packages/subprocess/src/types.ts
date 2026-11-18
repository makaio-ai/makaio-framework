import type { ChildProcess } from 'node:child_process';

/**
 * Options for spawning a subprocess.
 * @param command - Executable command (absolute path or PATH-resolved name).
 * @param args - Command-line arguments.
 * @param cwd - Working directory.
 * @param env - Environment variables (undefined values are filtered out).
 * @param processName - Human-readable label for diagnostics and error messages.
 */
export interface SubprocessSpawnOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly processName?: string;
}

/** Listener invoked when a parsed JSON message arrives from stdout. */
export type MessageListener = (message: unknown) => void;

/**
 * Listener invoked once when the transport ends without `close()`: the child
 * process could not be spawned, exited (with any code, including `0`), or was
 * killed by a signal it did not receive from `close()`. It runs after the last
 * stdout message was delivered. A malformed stdout line is not a transport
 * failure and never reaches this listener.
 */
export type ErrorListener = (error: Error) => void;

/**
 * JSONL-framed subprocess transport.
 *
 * Sends JSON objects as newline-delimited lines to stdin, receives them from
 * stdout. Supports multiple concurrent listeners.
 *
 * A stdout line that is not valid JSON carries no readable correlation and
 * leaves the process running, so the transport drops it and logs a diagnostic
 * that never includes the line itself. Error listeners only observe failures
 * that end the transport. A listener that throws is logged and isolated; it
 * neither ends the transport nor prevents later listeners from running.
 */
export interface IJsonlTransport {
  /** Send a JSON-serializable message to the subprocess via stdin. */
  send(message: object): void;
  /** Kill the subprocess and release resources. */
  close(): void;
  /** Register a message listener. Returns an unsubscribe function. */
  onMessage(listener: MessageListener): () => void;
  /** Register a listener for transport failures. Returns an unsubscribe function. */
  onError(listener: ErrorListener): () => void;
  /** The underlying child process (for lifecycle inspection). */
  readonly process: ChildProcess;
}
