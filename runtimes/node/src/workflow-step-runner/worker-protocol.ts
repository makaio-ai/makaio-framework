/**
 * Shared JSON-RPC protocol constants and helpers for worker communication.
 *
 * Used by both {@link ChildProcessStepRunner} and {@link DockerStepRunner}
 * to identify the ready notification, and by the worker entry module to emit it.
 */

/** The JSON-RPC ready notification object sent by worker processes on startup. */
export const JSONRPC_READY_MESSAGE = Object.freeze({ jsonrpc: '2.0', method: 'ready' } as const);

/**
 * Check whether a message is the JSON-RPC ready notification.
 * @param message - Parsed JSON message from the child process or container.
 * @returns `true` if the message is the ready signal.
 */
export function isReadyMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const msg = message as Record<string, unknown>;
  return msg['jsonrpc'] === '2.0' && msg['method'] === 'ready';
}
