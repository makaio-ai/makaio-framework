import type * as acp from '@agentclientprotocol/sdk';
import type { TerminalManager } from './terminal-manager.js';

/**
 * Configuration for spawning an ACP agent subprocess.
 */
export interface AcpConnectionOptions {
  /** Subprocess command (e.g., 'qwen') */
  command: string;
  /** CLI arguments (e.g., ['--acp', '--model', 'qwen3-coder']) */
  args: string[];
  /** Working directory for the subprocess */
  cwd: string;
  /** Environment variables passed to the subprocess */
  env: Record<string, string>;
  /** Callback for stderr output */
  onStderr?: (data: string) => void;
  /** Callback for subprocess spawn/runtime errors */
  onError?: (error: Error) => void;
  /** Callback for subprocess exit */
  onExit?: (code: number | null) => void;
  /**
   * Milliseconds to wait for the subprocess to start before failing.
   *
   * Required rather than optional: the wait for a `spawn` event has no natural
   * end, and every caller of this function already declares an initialization
   * budget. Making the budget an argument is what stops that declaration from
   * being decorative.
   */
  spawnTimeoutMs: number;
  /**
   * Signal that abandons the start before its budget expires.
   *
   * The budget answers "how long may this take"; the signal answers "we no longer
   * want it" — a caller whose own start was superseded or cancelled has no reason
   * to keep waiting out a full budget. An abandoned start kills the child it
   * spawned, exactly as an expired one does, so neither leaves an unwatched
   * process behind.
   */
  signal?: AbortSignal;
}

/**
 * Handle to a running ACP connection (subprocess + protocol layer).
 */
export interface AcpConnectionHandle {
  /** The ACP client-side connection for sending requests to the agent */
  connection: acp.ClientSideConnection;
  /** Kill the subprocess with SIGTERM */
  kill(): void;
  /** Promise that resolves with the exit code when the subprocess exits */
  exited: Promise<number | null>;
}

/**
 * Callbacks for routing ACP server requests to Makaio infrastructure.
 */
export interface MakaioAcpClientConfig {
  /**
   * Handle session update notifications (message chunks, tool calls, usage, etc.).
   * @param notification - The session notification from the agent
   */
  onSessionUpdate: (notification: acp.SessionNotification) => Promise<void>;
  /**
   * Handle permission requests (tool approval).
   * @param params - The permission request from the agent
   */
  onRequestPermission: (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
  /**
   * Handle file read requests. Only required if fs.readTextFile capability is advertised.
   * @param params - The read file request from the agent
   */
  onReadTextFile?: (params: acp.ReadTextFileRequest) => Promise<acp.ReadTextFileResponse>;
  /**
   * Handle file write requests. Only required if fs.writeTextFile capability is advertised.
   * @param params - The write file request from the agent
   */
  onWriteTextFile?: (params: acp.WriteTextFileRequest) => Promise<acp.WriteTextFileResponse>;
  /** Terminal lifecycle manager for stateful terminal operations */
  terminalManager?: TerminalManager;
}
