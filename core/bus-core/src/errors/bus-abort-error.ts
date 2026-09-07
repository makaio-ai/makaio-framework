/** Cancellation representation for reasons not recognized as Error objects. */
export class BusAbortError extends DOMException {
  /** Exact original cancellation reason, without serialization or coercion. */
  public readonly cause: unknown;

  /**
   * Wrap an unrecognized cancellation reason without losing its provenance.
   * @param reason - Original AbortSignal reason
   */
  public constructor(reason: unknown) {
    super(typeof reason === 'string' ? reason : 'Request aborted', 'AbortError');
    this.cause = reason;
  }
}

/**
 * Recognize local Errors/DOMExceptions and ordinary foreign-realm Errors.
 * Foreign objects with custom tags are deliberately not inferred to be Errors;
 * normalization retains such values unchanged as the wrapper's cause instead.
 * @param value - Candidate cancellation reason or rejection
 * @returns Whether the value can use the direct Error-identity contract
 */
function isRecognizedError(value: unknown): value is Error {
  try {
    return (
      value instanceof Error ||
      value instanceof DOMException ||
      (typeof value === 'object' &&
        value !== null &&
        !(Symbol.toStringTag in value) &&
        Object.prototype.toString.call(value) === '[object Error]')
    );
  } catch {
    // Introspection can fail for proxies; preserving their exact cause needs no inspection.
    return false;
  }
}

/**
 * Preserve recognized Error reasons and normalize other reasons for Error-only transport APIs.
 * Recognition is not universal across realms; unrecognized values retain exact cause identity.
 * @param reason - Original AbortSignal reason
 * @returns Recognized Error unchanged, or a wrapper retaining the exact original cause
 */
export function toAbortError(reason: unknown): Error {
  return isRecognizedError(reason) ? reason : new BusAbortError(reason);
}

/**
 * Identify cancellation belonging to this signal, not an unrelated concurrent failure.
 * Error names and messages alone cannot establish cancellation provenance.
 * @param error - Rejection to classify
 * @param signal - Signal supplied to the request
 * @returns Whether the rejection represents this signal's cancellation
 */
export function isRequestCancellation(error: unknown, signal?: AbortSignal): boolean {
  // Unrecognized reasons require the wrapper: equal raw values can be independent failures.
  return Boolean(
    signal?.aborted &&
      isRecognizedError(error) &&
      (Object.is(error, signal.reason) || (error instanceof BusAbortError && Object.is(error.cause, signal.reason))),
  );
}
