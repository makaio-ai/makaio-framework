import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SDKMessage } from '@makaio/client-claude-code';

/**
 * Callback invoked when a parsed SDK message arrives from stdout.
 * @param message - Parsed JSONL line as an SDK message
 */
type MessageCallback = (message: SDKMessage) => void;

/**
 * Callback invoked when an error occurs.
 * @param error - Error describing the failure
 */
type ErrorCallback = (error: Error) => void;

interface BufferedCallbacks {
  emitMessage: (message: SDKMessage) => void;
  emitError: (error: Error) => void;
  onMessage: (callback: MessageCallback) => void;
  onError: (callback: ErrorCallback) => void;
}

interface FirstOutputWatchdog {
  clear: () => void;
}

type CliSubprocess = ChildProcessWithoutNullStreams;

/**
 * Build the subprocess environment for the Claude CLI.
 * @param env - Fully resolved environment for the subprocess
 * @returns Environment object for `spawn()`
 */
function buildSpawnEnv(env: Record<string, string>): Record<string, string> {
  const mergedEnv: Record<string, string> = {};
  Object.assign(mergedEnv, env);
  const hasPath = mergedEnv['PATH'] !== undefined || mergedEnv['Path'] !== undefined;
  if (!hasPath) {
    const inheritedPath = process.env['PATH'] ?? process.env['Path'];
    if (inheritedPath !== undefined) {
      mergedEnv['PATH'] = inheritedPath;
    }
  }
  // Strip CLAUDECODE after merging so the claude CLI can be spawned as a subprocess
  // even when running inside another Claude Code session (e.g., during tests).
  delete mergedEnv['CLAUDECODE'];
  return mergedEnv;
}

/**
 * Create buffered emitters so events are not lost before callbacks are attached.
 * @returns Buffered emitters and callback registration functions
 */
function createBufferedCallbacks(): BufferedCallbacks {
  let messageCallback: MessageCallback | null = null;
  let errorCallback: ErrorCallback | null = null;
  const pendingMessages: SDKMessage[] = [];
  const pendingErrors: Error[] = [];

  const emitMessage = (message: SDKMessage): void => {
    if (messageCallback) {
      messageCallback(message);
    } else {
      pendingMessages.push(message);
    }
  };

  const emitError = (error: Error): void => {
    if (errorCallback) {
      errorCallback(error);
    } else {
      pendingErrors.push(error);
    }
  };

  const onMessage = (callback: MessageCallback): void => {
    messageCallback = callback;
    while (pendingMessages.length > 0) {
      const message = pendingMessages.shift();
      if (message === undefined) break;
      callback(message);
    }
  };

  const onError = (callback: ErrorCallback): void => {
    errorCallback = callback;
    while (pendingErrors.length > 0) {
      const error = pendingErrors.shift();
      if (error === undefined) break;
      callback(error);
    }
  };

  return {
    emitMessage,
    emitError,
    onMessage,
    onError,
  };
}

/**
 * Parse one JSONL line into an SDK message payload.
 *
 * Transport intentionally stays permissive because Claude CLI can emit
 * forward-compatible event variants that the shared schema may not yet model.
 * Higher layers (session) decide which message types to consume.
 * @param line - One complete JSONL line from stdout
 * @returns Parsed JSON payload cast as SDK message
 */
function parseSdkMessage(line: string): SDKMessage {
  return JSON.parse(line) as SDKMessage;
}

/**
 * Set up a first-output watchdog for the spawned CLI process.
 * @param subprocess - CLI subprocess
 * @param buffered - Buffered callback dispatcher
 * @param firstOutputTimeoutMs - Optional timeout in milliseconds
 * @returns Watchdog controller
 */
function createFirstOutputWatchdog(
  subprocess: CliSubprocess,
  buffered: BufferedCallbacks,
  firstOutputTimeoutMs?: number,
): FirstOutputWatchdog {
  let firstOutputTimer: ReturnType<typeof setTimeout> | undefined =
    firstOutputTimeoutMs !== undefined
      ? setTimeout(() => {
          subprocess.kill();
          buffered.emitError(
            new Error(
              `claude CLI produced no output within ${firstOutputTimeoutMs}ms. ` +
                'This may indicate an invalid --mcp-config (unreachable MCP server or malformed config).',
            ),
          );
        }, firstOutputTimeoutMs)
      : undefined;

  const clear = (): void => {
    if (firstOutputTimer !== undefined) {
      clearTimeout(firstOutputTimer);
      firstOutputTimer = undefined;
    }
  };

  return { clear };
}

/**
 * Wire stdout processing and line parsing for JSONL SDK messages.
 * @param subprocess - CLI subprocess
 * @param buffered - Buffered callback dispatcher
 * @param onFirstOutput - Callback invoked when first stdout bytes arrive
 * @returns Function to flush trailing buffered line on process exit
 */
function wireStdoutProcessing(
  subprocess: CliSubprocess,
  buffered: BufferedCallbacks,
  onFirstOutput: () => void,
): () => void {
  let buffer = '';

  const processLine = (line: string): void => {
    const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!normalizedLine.trim()) return;

    try {
      const message = parseSdkMessage(normalizedLine);
      buffered.emitMessage(message);
    } catch (err) {
      const error =
        err instanceof Error
          ? new Error(`Failed to parse JSONL: ${err.message}`)
          : new Error(`Failed to parse JSONL: ${normalizedLine}`);
      buffered.emitError(error);
    }
  };

  subprocess.stdout.on('data', (chunk: Buffer) => {
    onFirstOutput();
    buffer += chunk.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      processLine(line);
    }
  });

  return () => {
    processLine(buffer);
    buffer = '';
  };
}

/**
 * Transport interface for the `claude` CLI subprocess.
 *
 * The CLI is spawned in print mode (`-p`) and emits one JSON object per
 * line to stdout when `--output-format stream-json` is set.
 */
export interface CliStdioTransport {
  /**
   * Register a callback for messages received from stdout.
   * @param callback - Function to handle each parsed JSONL message
   */
  onMessage(callback: MessageCallback): void;

  /**
   * Register a callback for errors.
   * @param callback - Function to handle errors
   */
  onError(callback: ErrorCallback): void;

  /**
   * Close the subprocess and cleanup resources.
   */
  close(): void;
}

/**
 * Spawn the `claude` CLI and parse its JSONL stdout into SDK messages.
 *
 * The CLI is run in non-interactive print mode. Each line of stdout is
 * parsed as a JSON object and delivered to the registered message callback.
 * stderr is forwarded to console.warn for diagnostics.
 *
 * An optional `firstOutputTimeoutMs` watchdog kills the process if no stdout
 * arrives within the given window. This guards against silent hangs caused by
 * an invalid `--mcp-config` (the claude CLI blocks indefinitely waiting for the
 * MCP server to respond when the config is malformed).
 * @param args - CLI arguments (e.g., from buildCliArgs())
 * @param cwd - Working directory for the subprocess
 * @param env - Environment variables (undefined values are filtered out)
 * @param binaryPath - Absolute path to the `claude` binary; falls back to `'claude'` (PATH lookup)
 * @param firstOutputTimeoutMs - Milliseconds to wait for the first stdout byte before
 *   killing the process and emitting an error. Pass `undefined` to disable.
 * @returns Transport interface for receiving messages and closing the process
 */
export function createStdioTransport(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  binaryPath?: string,
  firstOutputTimeoutMs?: number,
): CliStdioTransport {
  const subprocess = spawn(binaryPath ?? 'claude', args, {
    cwd,
    env: buildSpawnEnv(env),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as CliSubprocess;

  // Close stdin immediately — the CLI receives its prompt via args, not stdin.
  // Leaving stdin open can cause the process to wait for input before flushing stdout.
  subprocess.stdin.end();

  const buffered = createBufferedCallbacks();
  const watchdog = createFirstOutputWatchdog(subprocess, buffered, firstOutputTimeoutMs);
  const flushPendingStdoutLine = wireStdoutProcessing(subprocess, buffered, () => watchdog.clear());

  subprocess.stderr.on('data', (chunk: Buffer) => {
    console.warn('[claude-code-cli]', chunk.toString('utf-8'));
  });

  subprocess.on('error', (error: Error) => {
    watchdog.clear();
    buffered.emitError(error);
  });

  subprocess.on('exit', (code: number | null) => {
    watchdog.clear();
    flushPendingStdoutLine();

    // Code 0 = success; null = killed by signal (close() path — not an error)
    if (code !== 0 && code !== null) {
      buffered.emitError(new Error(`claude CLI exited with code ${code}`));
    }
  });

  return {
    onMessage(callback: MessageCallback): void {
      buffered.onMessage(callback);
    },

    onError(callback: ErrorCallback): void {
      buffered.onError(callback);
    },

    close(): void {
      watchdog.clear();
      subprocess.kill();
    },
  };
}
