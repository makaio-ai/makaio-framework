/**
 * Typed error classes for the client binary management subsystem.
 * @packageDocumentation
 */

/**
 * Thrown by `client.resolveBinary` when no managed version is active and the
 * global PATH scan finds no matching binary for the client.
 *
 * Callers that need to distinguish "binary absent" from other resolution
 * failures (e.g. corrupted managed state, storage errors) should check for
 * this class rather than matching the error message string.
 */
export class BinaryNotFoundError extends Error {
  /** Discriminant code for structured error detection without string matching. */
  public readonly code = 'BINARY_NOT_FOUND' as const;

  /**
   * @param clientId - Stable client identifier for which no binary was found
   */
  public constructor(clientId: string) {
    super(
      `client.resolveBinary: no binary found for client '${clientId}' — ` +
        `install a managed version or ensure the binary is on PATH`,
    );
    this.name = 'BinaryNotFoundError';
    Error.captureStackTrace?.(this, BinaryNotFoundError);
  }
}
