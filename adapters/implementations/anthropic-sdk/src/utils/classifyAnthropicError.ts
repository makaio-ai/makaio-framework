import { APIError } from '@anthropic-ai/sdk';
import { RateLimitError, AuthenticationError, ModelUnavailableError, QuotaExceededError } from '@makaio/core';

/** Anthropic API error body shape for type-narrowing the `error` field on `APIError`. */
interface AnthropicErrorBody {
  type?: string;
  message?: string;
}

/**
 * Narrows an opaque `APIError.error` value to `AnthropicErrorBody`.
 * The Anthropic SDK types `error` as `Object | undefined`; this guard
 * confirms it is a plain object with an optional `type` string.
 * @param value - The raw error body from `APIError.error`.
 * @returns `true` when the value can be treated as `AnthropicErrorBody`.
 */
function isAnthropicErrorBody(value: unknown): value is AnthropicErrorBody {
  return typeof value === 'object' && value !== null;
}

/**
 * Maps Anthropic SDK errors to Makaio error subclasses.
 *
 * Classification priority:
 * 1. HTTP status codes (definitive).
 * 2. Error body `type` field (Anthropic API error objects).
 * 3. Message content (fallback heuristics).
 *
 * Anthropic-specific status 529 (overloaded) is mapped to {@link RateLimitError}
 * as the closest Makaio semantic — both indicate a transient capacity constraint.
 * @param error - The error thrown by the Anthropic SDK.
 * @returns A classified Makaio error, or the original error when unrecognised.
 */
export function classifyAnthropicError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }

  if (!(error instanceof APIError)) {
    return classifyByMessage(error);
  }

  const { status, message } = error;
  const errorType = isAnthropicErrorBody(error.error) ? error.error.type : undefined;

  // --- HTTP status: definitive classification ---
  if (status === 401 || status === 403) {
    return new AuthenticationError(message);
  }
  if (status === 404) {
    // 404 can mean a missing resource (route, version, etc.) not just a bad
    // model ID. Only classify as ModelUnavailableError when the message body
    // explicitly references the model.
    const messageLower404 = message.toLowerCase();
    if (messageLower404.includes('model')) {
      return new ModelUnavailableError(message);
    }
    return new Error(message);
  }
  if (status === 429) {
    return classifyRateLimitOrQuota(message, errorType);
  }
  // 529 is Anthropic's overloaded status — transient, retry-safe, closest to rate limiting
  if (status === 529) {
    return new RateLimitError(message);
  }

  // --- Error body type: API-level classification ---
  if (errorType !== undefined) {
    const classified = classifyByErrorType(errorType, message);
    if (classified !== undefined) {
      return classified;
    }
  }

  // --- Message heuristics: fallback ---
  return classifyByMessage(error);
}

/**
 * Distinguishes quota exhaustion from transient rate limiting for HTTP 429 responses.
 * @param message - The error message string.
 * @param errorType - The Anthropic API error type from the response body, if present.
 * @returns {@link QuotaExceededError} for quota exhaustion, {@link RateLimitError} otherwise.
 */
function classifyRateLimitOrQuota(message: string, errorType: string | undefined): Error {
  const messageLower = message.toLowerCase();
  if (messageLower.includes('quota') || messageLower.includes('credit') || errorType === 'billing_error') {
    return new QuotaExceededError(message);
  }
  return new RateLimitError(message);
}

/**
 * Maps Anthropic API error body `type` strings to Makaio error subclasses.
 * @param errorType - The `type` field from the Anthropic error response body.
 * @param message - The error message string.
 * @returns A Makaio error subclass, or `undefined` when the type is unrecognised.
 */
function classifyByErrorType(errorType: string, message: string): Error | undefined {
  switch (errorType) {
    case 'authentication_error':
    case 'permission_error':
      return new AuthenticationError(message);
    case 'not_found_error': {
      const messageLower = message.toLowerCase();
      return messageLower.includes('model') ? new ModelUnavailableError(message) : new Error(message);
    }
    case 'rate_limit_error':
      return new RateLimitError(message);
    case 'billing_error':
      return new QuotaExceededError(message);
    case 'overloaded_error':
      return new RateLimitError(message);
    default:
      return undefined;
  }
}

/**
 * Heuristic fallback classifier that inspects error message content.
 * Used when neither status codes nor error body types are available.
 * @param error - The original error instance.
 * @returns A Makaio error subclass when a known pattern is detected, or the original error.
 */
function classifyByMessage(error: Error): Error {
  const messageLower = error.message.toLowerCase();
  if (messageLower.includes('authentication') || messageLower.includes('unauthorized')) {
    return new AuthenticationError(error.message);
  }
  if (messageLower.includes('rate limit') || messageLower.includes('too many requests')) {
    return new RateLimitError(error.message);
  }
  if (messageLower.includes('quota') || messageLower.includes('credit')) {
    return new QuotaExceededError(error.message);
  }
  if (messageLower.includes('model not found') || messageLower.includes('unknown model')) {
    return new ModelUnavailableError(error.message);
  }
  return error;
}
