/** Stable connection failure categories; callers own the retry policy. */
export type WebSocketConnectionErrorCode =
  | 'WS_CONNECTION_UNAVAILABLE'
  | 'WS_HANDSHAKE_TIMEOUT'
  | 'WS_CONNECTION_TIMEOUT'
  | 'WS_AUTHENTICATION_REJECTED'
  | 'WS_POLICY_REJECTED';

/** A transport-classified failure, distinct from unknown factory, codec or auth errors. */
export class WebSocketConnectionError extends Error {
  /**
   * @param code - Machine-readable failure category.
   * @param message - Human-readable diagnostic.
   * @param options - Original cause, when available.
   */
  public constructor(
    public readonly code: WebSocketConnectionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WebSocketConnectionError';
  }
}

/**
 * Classify a socket close using its protocol status, never diagnostic text.
 * @param event - Socket close event.
 * @returns Classified connection error.
 */
export function connectionClosedError(event?: unknown): WebSocketConnectionError {
  const policy = typeof event === 'object' && event !== null && 'code' in event && event.code === 1008;
  return new WebSocketConnectionError(
    policy ? 'WS_POLICY_REJECTED' : 'WS_CONNECTION_UNAVAILABLE',
    policy ? 'WebSocket connection rejected by peer policy' : 'WebSocket closed before connection completed',
  );
}
