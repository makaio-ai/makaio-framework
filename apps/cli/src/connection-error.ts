/** Fallback message when no specific connection error is available. */
export const DEFAULT_CONNECTION_ERROR =
  'Could not connect to Makaio server. Is it running?\nStart it with: makaio serve';

/**
 * Format the connection error shown to CLI users.
 * @param connectionError - Specific connection failure detail when available.
 * @returns A human-readable error message.
 */
export function formatConnectionError(connectionError?: string): string {
  return connectionError ?? DEFAULT_CONNECTION_ERROR;
}
