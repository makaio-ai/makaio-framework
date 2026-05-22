import { MakaioError } from '@makaio/core';

/**
 * Error codes for framework canonical-model resolution failures.
 */
export type CanonicalModelResolutionErrorCode =
  | 'ambiguous-model'
  | 'model-not-found'
  | 'adapter-not-found'
  | 'provider-not-found'
  | 'no-binding';

/**
 * Thrown when framework canonical-model resolution fails.
 *
 * Contains actionable suggestions the caller can present to the user.
 */
export class CanonicalModelResolutionError extends MakaioError {
  /**
   * Creates a canonical model resolution error.
   * @param message - Human-readable error message
   * @param code - Machine-readable error code for programmatic handling
   * @param suggestions - Fully qualified canonical names the user can try instead
   */
  public constructor(
    message: string,
    public readonly code: CanonicalModelResolutionErrorCode,
    public readonly suggestions?: string[],
  ) {
    super(message);
  }
}
