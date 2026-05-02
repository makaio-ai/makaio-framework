import { BusError } from './bus-error.js';

/**
 * Error thrown when a request times out.
 */
export class TimeoutError extends BusError {
  /**
   * @param subject - Fully-qualified subject name for the timed-out request
   * @param timeoutMs - Timeout duration in milliseconds that was exceeded
   */
  public constructor(
    subject: string,
    public readonly timeoutMs: number,
  ) {
    super(`Request to "${subject}" timed out after ${timeoutMs}ms`, subject);
  }
}
