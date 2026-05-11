import { spawn } from 'node:child_process';
import type { IJsonlTransport, MessageListener, ErrorListener, SubprocessSpawnOptions } from './types.js';
import { decodeJsonlChunk } from './jsonl-framing.js';

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

  subprocess.stdout.on('data', (chunk: Buffer) => {
    const result = decodeJsonlChunk(chunk.toString('utf-8'), buffer);
    buffer = result.remaining;

    for (const message of result.messages) {
      for (const listener of messageListeners) listener(message);
    }
    for (const line of result.errors) {
      const error = new Error(`Failed to parse JSONL from ${processName}: ${line}`);
      for (const listener of errorListeners) listener(error);
    }
  });

  subprocess.stderr.on('data', (chunk: Buffer) => {
    console.warn(`[${processName}]`, chunk.toString('utf-8'));
  });

  subprocess.on('error', (error: Error) => {
    for (const listener of errorListeners) listener(error);
  });

  subprocess.on('exit', (code: number | null) => {
    if (code !== 0 && code !== null) {
      const error = new Error(`${processName} exited with code ${code}`);
      for (const listener of errorListeners) listener(error);
    }
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
