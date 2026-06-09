import {
  InvalidModelError,
  RateLimitError,
  AuthenticationError,
  ModelUnavailableError,
  QuotaExceededError,
} from '@makaio/core';

/**
 * Classify error by subtype (most reliable for Claude SDK).
 * @param subtype - Error subtype from SDK
 * @param errorMessage - Error message to use
 * @param result - Optional result message for model extraction
 * @returns Classified error or null if not matched
 */
function classifyBySubtype(subtype: string, errorMessage: string | unknown, result?: string): Error | null {
  const message = typeof errorMessage === 'string' ? errorMessage : '';

  switch (subtype) {
    case 'rate_limit_error':
      return new RateLimitError(message || 'Rate limit exceeded');

    case 'authentication_error':
    case 'permission_error':
      return new AuthenticationError(message || 'Authentication failed');

    case 'overloaded_error':
      return new QuotaExceededError(message || 'Service overloaded');

    case 'not_found_error': {
      const invalidModelName = typeof result === 'string' ? result.match(/model: ([^"]*)/)?.[1] : null;
      if (invalidModelName) {
        return new InvalidModelError(invalidModelName);
      }
      return new ModelUnavailableError(message || 'Model not found');
    }

    default:
      return null;
  }
}

/**
 * Resolve the most specific error text exposed by the SDK result payload.
 * Native structured-output failures surface their actionable diagnostics in
 * `errors[]` rather than `result`, so keep those details ahead of subtype
 * fallbacks.
 * @param msg - SDK result message with possible error details.
 * @returns Specific error text when available.
 */
function resolveResultErrorMessage(msg: {
  subtype: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  stop_reason?: string | null;
}): string {
  if (msg.subtype !== 'success' && msg.errors && msg.errors.length > 0) {
    return msg.errors.join('\n');
  }
  if (msg.subtype === 'success' && msg.is_error && msg.result) {
    return msg.result;
  }
  return msg.subtype;
}

/**
 * Classify error by message content for success+is_error cases.
 * @param message - Error message to analyze
 * @returns Classified error or null if not matched
 */
function classifyByMessageContent(message: string): Error | null {
  const lower = message.toLowerCase();

  if (lower.includes('rate limit') || lower.includes('rate_limit')) {
    return new RateLimitError(message);
  }
  if (lower.includes('quota') || lower.includes('overloaded')) {
    return new QuotaExceededError(message);
  }
  if (lower.includes('authentication') || lower.includes('unauthorized') || lower.includes('permission')) {
    return new AuthenticationError(message);
  }
  if (lower.includes('model') && (lower.includes('not found') || lower.includes('unavailable'))) {
    return new ModelUnavailableError(message);
  }

  return null;
}

/**
 * Parse SDK result message error into appropriate error object.
 *
 * Claude SDK has a quirk where some errors come as:
 * - subtype: 'success' with is_error: true and error text in result
 * - subtype: error type (e.g., 'api_error') without is_error flag
 *
 * This function extracts and classifies errors:
 * - InvalidModelError / ModelUnavailableError for not_found_error with model name
 * - RateLimitError for rate_limit_error subtype
 * - AuthenticationError for authentication_error / permission_error
 * - QuotaExceededError for overloaded_error (quota exceeded)
 * - Full error message text for success+is_error cases
 * - Resolved SDK error message as fallback (`errors[]`, `result`, or subtype)
 * @param msg - SDK result message with error info
 * @returns Parsed error (MakaioError subclass, Error, or string)
 */
export function parseResultError(msg: {
  subtype: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  stop_reason?: string | null;
}): Error | string {
  const isWeirdSuccessWithError = msg.subtype === 'success' && msg.is_error;
  const errorMessage = resolveResultErrorMessage(msg);

  // Try subtype classification first
  const subtypeError = classifyBySubtype(msg.subtype, errorMessage, msg.result);
  if (subtypeError) {
    return subtypeError;
  }

  // For success+is_error cases, try message content classification
  if (isWeirdSuccessWithError && typeof msg.result === 'string') {
    const contentError = classifyByMessageContent(msg.result);
    if (contentError) {
      return contentError;
    }
    return msg.result;
  }

  // Fallback to SDK error details or subtype.
  return errorMessage;
}
