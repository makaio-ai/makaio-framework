import type { JournalAcceptErrorCode } from './record.js';

/**
 * Typed journal error with a stable machine-readable code.
 *
 * Thrown by `record` and `accept`. The code is one of the lower-case
 * hyphenated journal codes (for example `payload-invalid` or `cursor-moved`).
 */
export class JournalError extends Error {
  /**
   * @param code - Machine-readable error code from {@link JournalAcceptErrorCode}.
   * @param message - Human-readable error description.
   */
  public constructor(
    public readonly code: JournalAcceptErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JournalError';
  }
}
