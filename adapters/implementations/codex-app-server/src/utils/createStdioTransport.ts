import { spawn } from 'node:child_process';
import * as path from 'node:path';
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

  /**
   * Handle subprocess exit
   */
  subprocess.on('exit', (code: number | null) => {
    if (code !== 0) {
      const error = new Error(`codex app-server exited with code ${code ?? 'unknown'}`);
      errorCallback?.(error);
    }
  });

  return {
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
