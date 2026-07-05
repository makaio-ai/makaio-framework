import { BusError } from './bus-error.js';

/**
 * Stable error code for connection-lost failures.
 *
 * Distinguishes transport disconnection from "no handler registered"
 * ({@link NoHandlerError}) so callers can decide whether to retry.
 */
export const CONNECTION_LOST_ERROR_CODE = 'CONNECTION_LOST' as const;

/**
 * Error thrown when a pending request is abandoned because the underlying
 * transport connection was lost before a response arrived.
 *
 * Unlike {@link NoHandlerError}, this error indicates that a handler may
 * well exist — the connection dropped before the response could be
 * delivered. Callers should treat this as retryable.
 */
export class ConnectionLostError extends BusError {
  public readonly code = CONNECTION_LOST_ERROR_CODE;

  /**
   * Whether the operation is safe to retry after reconnection.
   */
  public readonly retryable = true;

  /**
   * @param transportName - Name of the transport whose connection was lost
   */
  public constructor(transportName: string) {
    super(
      `Connection lost on transport "${transportName}" — pending requests were rejected. ` +
        `This is retryable after reconnection.`,
    );
  }
}
