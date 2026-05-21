import { MakaioError } from '@makaio/core';

/**
 * Base error class for all bus-related errors.
 */
export class BusError extends MakaioError {
  /**
   * @param message - Human-readable error description
   * @param subject - Fully-qualified subject name (namespace.subject) for the failed operation
   */
  public constructor(
    message: string,
    public readonly subject?: string,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
}
