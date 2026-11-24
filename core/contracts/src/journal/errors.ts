import type { JournalAcceptErrorCode } from './record.js';

/**
 * Typed journal error with a stable machine-readable code.
 *
 * Thrown by `record` and `accept`. The code is one of the lower-case
 * hyphenated journal codes (for example `payload-invalid` or `cursor-moved`).
 */
export class JournalError extends Error {
  /**
   * @param code - Machine-readable error code for either operation. {@link JournalAcceptErrorCode}
   *   includes all recording error codes.
   * @param message - Human-readable error description.
   * @param options - Optional underlying cause.
   */
  public constructor(
    public readonly code: JournalAcceptErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'JournalError';
  }
}
