import { BusError } from './bus-error.js';

/**
 * Stable error code for "no handler registered" failures.
 */
export const NO_HANDLER_ERROR_CODE = 'NO_HANDLER' as const;

/**
 * Error thrown when no handler is registered for a request.
 */
export class NoHandlerError extends BusError {
  public readonly code = NO_HANDLER_ERROR_CODE;

  /**
   * @param subject - Fully-qualified subject name for which no handler was found
   */
  public constructor(subject: string) {
    super(`No handler registered for request subject "${subject}"`, subject);
  }
}
