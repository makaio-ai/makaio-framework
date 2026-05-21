/**
 * Machine-readable error code for user-cancelled connector swap operations.
 */
export const CONNECTOR_SWAP_CANCELLED_CODE = 'CONNECTOR_SWAP_CANCELLED';

/**
 * Raised when the user cancels connector swap from the warning dialog.
 */
export class ConnectorSwapCancelledError extends Error {
  public readonly code = CONNECTOR_SWAP_CANCELLED_CODE;

  public constructor() {
    super('Connector swap cancelled by user');
    this.name = 'ConnectorSwapCancelledError';
  }
}

/**
 * Type guard for connector swap cancellation errors.
 * @param error - Unknown error value
 * @returns True when error matches connector swap cancellation contract
 */
export function isConnectorSwapCancelledError(error: unknown): error is ConnectorSwapCancelledError {
  return (
    error instanceof ConnectorSwapCancelledError ||
    (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === CONNECTOR_SWAP_CANCELLED_CODE)
  );
}
