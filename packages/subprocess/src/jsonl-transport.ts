import { spawn } from 'node:child_process';
import type { IJsonlTransport, MessageListener, ErrorListener, SubprocessSpawnOptions } from './types.js';
import { decodeJsonlChunk } from './jsonl-framing.js';
import { notifyListeners } from './notify-listeners.js';

/**
 * Spawn a subprocess and communicate via newline-delimited JSON on stdin/stdout.
 * @param options - Spawn configuration.
 * @returns Transport interface for bidirectional JSONL communication.
 */
export function createJsonlTransport(options: SubprocessSpawnOptions): IJsonlTransport {
  const { command, args = [], cwd, env, processName = command } = options;

  const cleanEnv = env
    ? (Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>)
    : {};

  const subprocess = spawn(command, [...args], {
    cwd,
    env: { ...process.env, ...cleanEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const messageListeners = new Set<MessageListener>();
  const errorListeners = new Set<ErrorListener>();
  let buffer = '';

  // Cause named by an `error` event, reported by the `close` that follows it.
  let spawnError: Error | undefined;

  /**
   * Notify every listener, logging (rather than propagating) a listener that throws.
   * @param listeners - Listeners to notify.
   * @param value - Value passed to each listener.
   */
  function notifyAll<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
    notifyListeners(listeners, value, (error) => console.error(`[${processName}] transport listener threw`, error));
  }

  subprocess.stdout.on('data', (chunk: Buffer) => {
    const result = decodeJsonlChunk(chunk.toString('utf-8'), buffer);
    buffer = result.remaining;

    for (const message of result.messages) {
      notifyAll(messageListeners, message);
    }
    // A malformed line names no request and leaves the process running, so it
    // is a diagnostic, not a transport failure.
    if (result.malformedLineCount > 0) {
      console.warn(`[${processName}] dropped ${result.malformedLineCount} malformed JSONL line(s) from stdout`);
    }
  });

  subprocess.stderr.on('data', (chunk: Buffer) => {
    console.warn(`[${processName}]`, chunk.toString('utf-8'));
  });

  // A child emits `error` when it could not be spawned or could not be killed.
  // The only kill this transport issues is in `close()`, after the listeners
  // are cleared, so the error that matters here is a failed spawn; it does not
  // end the transport by itself but names the cause of the `close` that follows.
  subprocess.on('error', (error: Error) => {
    spawnError = error;
  });

  // The transport ends exactly once, on `close`: the one event every spawn
  // attempt reaches (a failed spawn emits `error` and `close`, never `exit`), and
  // the only one that follows the last stdout chunk, so a response written just
  // before a clean exit is still delivered. `close()` clears the listeners before
  // it kills the process, so every end that still reaches them, by any exit code
  // or by signal, was not requested and leaves nothing to answer later writes.
  // TODO(FACT-459): bound the drain after `exit`. A descendant that inherited
  // stdout delays `close` until it releases the pipe, so until then a JSON-RPC
  // request without a timeout and a stdio server's pending correlations stay
  // open. The subprocess lifecycle redesign starts a configurable drain deadline
  // at the observed exit, clamped to the caller's budget, and ends the transport
  // when it expires; a timer here would duplicate that state ahead of it.
  subprocess.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    const cause = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
    notifyAll(errorListeners, spawnError ?? new Error(`${processName} exited with ${cause}`));
  });

  return {
    send(message: object): void {
      subprocess.stdin.write(JSON.stringify(message) + '\n');
    },

    close(): void {
      messageListeners.clear();
      errorListeners.clear();
      subprocess.kill();
    },

    onMessage(listener: MessageListener): () => void {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },

    onError(listener: ErrorListener): () => void {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },

    get process() {
      return subprocess;
    },
  };
}
