import { BusError } from './bus-error.js';

/**
 * Generic error thrown when a request fails for any other reason.
 */
export class RequestError extends BusError {
  /**
   * @param subject - Fully-qualified subject name for the failed request
   * @param message - Human-readable description of the failure
   * @param cause - Underlying error thrown by the handler, if any
   */
  public constructor(
    subject: string,
    message: string,
    public readonly cause?: Error,
  ) {
    super(`Request to "${subject}" failed: ${message}`, subject);
    if (cause) {
      this.cause = cause;
    }
  }
}
