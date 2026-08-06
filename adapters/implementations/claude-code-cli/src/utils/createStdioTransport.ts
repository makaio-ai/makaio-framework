import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SDKMessage } from '@makaio/client-claude-code';
import { DeferredPromise } from '@makaio/utils';

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

  /**
   * Settles once the spawned CLI process has ended, with the exit code it
   * reported or `null` when it was ended by a signal or never ran.
   *
   * The transport already observed the exit through a listener, but a caller
   * that asked for the close had no way to await that observation — so "the
   * close path ran" was the only fact available to it. This promise is the
   * observation itself: awaiting it after {@link close} is the difference
   * between having requested a termination and having watched one happen.
   *
   * Settled by the same `exit` listener that flushes stdout and classifies the
   * code, and by `close` for the spawn that never produced one: a missing binary
   * emits `error` and `close` and no `exit`, and an `exit`-only promise would
   * hang forever for a process that never existed — burning a caller's whole
   * observation budget and then reporting an unobserved end for nothing. It never
   * rejects; a failure to spawn is reported on the error channel, and this promise
   * answers only "is it over".
   */
  readonly exited: Promise<number | null>;
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

  // The exit promise is settled from inside the existing `exit` listener rather
  // than by a second `once('exit')` subscription, so the observation the transport
  // already makes is the one callers await. `close` below is not a second
  // observation of the same event but the answer for the spawn that produced no
  // `exit` to observe.
  const settleExited = new DeferredPromise<number | null>();
  // Last code an `exit` reported, so the `close` fallback answers with what was
  // observed instead of guessing again. Stays `null` for a process that never ran,
  // which is the same "ended without a code" a signalled termination reports.
  let lastExitCode: number | null = null;

  subprocess.on('exit', (code: number | null) => {
    watchdog.clear();
    flushPendingStdoutLine();

    // Code 0 = success; null = killed by signal (close() path — not an error)
    if (code !== 0 && code !== null) {
      buffered.emitError(new Error(`claude CLI exited with code ${code}`));
    }

    lastExitCode = code;
    settleExited.resolve(code);
  });

  // **The event every spawn attempt reaches**, including one that never produced a
  // process to exit. After a real exit this is a second resolve on an already
  // settled promise, which is a no-op — the classification above stays the `exit`
  // listener's alone.
  subprocess.on('close', () => {
    settleExited.resolve(lastExitCode);
  });

  return {
    exited: settleExited.getPromise(),

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
