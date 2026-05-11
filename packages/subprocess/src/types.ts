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

/** Listener invoked when an error occurs (parse failure, process error, non-zero exit). */
export type ErrorListener = (error: Error) => void;

/**
 * JSONL-framed subprocess transport.
 *
 * Sends JSON objects as newline-delimited lines to stdin, receives them from
 * stdout. Supports multiple concurrent listeners.
 */
export interface IJsonlTransport {
  /** Send a JSON-serializable message to the subprocess via stdin. */
  send(message: object): void;
  /** Kill the subprocess and release resources. */
  close(): void;
  /** Register a message listener. Returns an unsubscribe function. */
  onMessage(listener: MessageListener): () => void;
  /** Register an error listener. Returns an unsubscribe function. */
  onError(listener: ErrorListener): () => void;
  /** The underlying child process (for lifecycle inspection). */
  readonly process: ChildProcess;
}
