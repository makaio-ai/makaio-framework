import { RateLimitError, AuthenticationError, ModelUnavailableError, QuotaExceededError } from '@makaio/core';

/**
 * Classify error from OpenAI SDK into appropriate MakaioError subclass.
 * OpenAI SDK throws typed APIError with status codes and error types.
 * @param error - Error from OpenAI SDK
 * @returns MakaioError subclass instance or the original error
 */
export function classifyOpenAIError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }

  const errorWithProps = error as Error & {
    status?: number;
    code?: string;
    type?: string;
  };

  const status = errorWithProps.status;
  const message = error.message;
  const messageLower = message.toLowerCase();

  // Check HTTP status codes for definitive classification
  if (status === 401 || status === 403) {
    return new AuthenticationError(message);
  }
  if (status === 404 && (messageLower.includes('model') || errorWithProps.code === 'model_not_found')) {
    return new ModelUnavailableError(message);
  }
  if (status === 429) {
    // Check if it's quota exceeded vs rate limit
    if (
      messageLower.includes('quota') ||
      messageLower.includes('insufficient_quota') ||
      errorWithProps.code === 'insufficient_quota'
    ) {
      return new QuotaExceededError(message);
    }
    return new RateLimitError(message);
  }

  // Fall back to message/code content matching
  if (errorWithProps.type === 'insufficient_quota' || messageLower.includes('quota exceeded')) {
    return new QuotaExceededError(message);
  }
  if (messageLower.includes('rate limit') || errorWithProps.code === 'rate_limit_exceeded') {
    return new RateLimitError(message);
  }
  if (
    messageLower.includes('authentication') ||
    messageLower.includes('unauthorized') ||
    errorWithProps.code === 'invalid_api_key'
  ) {
    return new AuthenticationError(message);
  }

  // Unclassified - return original error (no errorCategory)
  return error;
}
