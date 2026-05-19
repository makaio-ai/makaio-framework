/**
 * Tests for classifyAnthropicError.
 *
 * Covers all three classification layers:
 * 1. HTTP status codes (401, 403, 404, 429, 529)
 * 2. Error body `type` field (authentication_error, permission_error, etc.)
 * 3. Message heuristic fallback
 *
 * Uses real Anthropic SDK `APIError` instances and real Makaio error classes — no mocks.
 */

import { describe, it, expect } from 'bun:test';
import { APIError } from '@anthropic-ai/sdk';
import { AuthenticationError, RateLimitError, QuotaExceededError, ModelUnavailableError } from '@makaio/core';
import { classifyAnthropicError } from '../utils/classifyAnthropicError.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal `Headers` stub that satisfies the SDK's `headers.get()` call
 * inside the `APIError` constructor without requiring a real network `Headers` instance.
 */
function makeHeaders(): Headers {
  return new Headers();
}

/**
 * Constructs an `APIError` with the given status, error body, and message.
 * The SDK's `makeMessage` formats `.message` as `"${status} ${errorBody.message}"`
 * when `errorBody.message` is a string, or just `"${status} status code (no body)"` when absent.
 * @param status - HTTP status code.
 * @param errorBody - The structured error body (maps to `APIError.error`).
 * @param rawMessage - Fallback message used when `errorBody` has no `.message`.
 * @returns A constructed `APIError` instance.
 */
function makeAPIError(status: number, errorBody: Record<string, unknown>, rawMessage?: string): APIError {
  return new APIError(status, errorBody, rawMessage, makeHeaders());
}

// ---------------------------------------------------------------------------
// HTTP status code classification
// ---------------------------------------------------------------------------

describe('classifyAnthropicError — HTTP status codes', () => {
  it('classifies status 401 as AuthenticationError', () => {
    const error = makeAPIError(401, { message: 'Invalid API key' });
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(AuthenticationError);
  });

  it('classifies status 403 as AuthenticationError', () => {
    const error = makeAPIError(403, { message: 'Forbidden' });
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(AuthenticationError);
  });

  it('classifies status 404 with "model" in message as ModelUnavailableError', () => {
    const error = makeAPIError(404, { message: 'model not found: claude-x' });
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(ModelUnavailableError);
  });

  it('classifies status 404 without "model" in message as plain Error', () => {
    const error = makeAPIError(404, { message: 'Resource not found' });
    const result = classifyAnthropicError(error);

    expect(result.constructor).toBe(Error);
  });

  it('classifies status 429 with no quota keywords as RateLimitError', () => {
    const error = makeAPIError(429, { message: 'Too many requests' });
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(RateLimitError);
  });

  it('classifies status 429 with "quota" in message as QuotaExceededError', () => {
    const error = makeAPIError(429, { message: 'Monthly quota exceeded' });
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(QuotaExceededError);
  });

  it('classifies status 429 with "credit" in message as QuotaExceededError', () => {
    const error = makeAPIError(429, { message: 'Insufficient credits' });
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(QuotaExceededError);
  });

  it('classifies status 429 with billing_error body type as QuotaExceededError', () => {
    const error = makeAPIError(429, { type: 'billing_error', message: 'Rate limited' });
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(QuotaExceededError);
  });

  it('classifies status 529 as RateLimitError', () => {
    const error = makeAPIError(529, { message: 'Overloaded' });
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(RateLimitError);
  });
});

// ---------------------------------------------------------------------------
// Error body `type` classification
// ---------------------------------------------------------------------------

describe('classifyAnthropicError — error body type field', () => {
  it('classifies authentication_error body type as AuthenticationError', () => {
    // Use a status that does not trigger a status-based classification (e.g. 400)
    const error = makeAPIError(400, { type: 'authentication_error', message: 'Bad credentials' });
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(AuthenticationError);
  });

  it('classifies permission_error body type as AuthenticationError', () => {
    const error = makeAPIError(400, { type: 'permission_error', message: 'Access denied' });
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(AuthenticationError);
  });

  it('classifies not_found_error body type with "model" in message as ModelUnavailableError', () => {
    const error = makeAPIError(400, { type: 'not_found_error', message: 'Unknown model requested' });
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(ModelUnavailableError);
  });

  it('classifies not_found_error body type without "model" in message as plain Error', () => {
    const error = makeAPIError(400, { type: 'not_found_error', message: 'Endpoint not found' });
    const result = classifyAnthropicError(error);

    expect(result.constructor).toBe(Error);
  });

  it('classifies rate_limit_error body type as RateLimitError', () => {
    const error = makeAPIError(400, { type: 'rate_limit_error', message: 'Slow down' });
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(RateLimitError);
  });

  it('classifies billing_error body type as QuotaExceededError', () => {
    const error = makeAPIError(400, { type: 'billing_error', message: 'Payment required' });
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(QuotaExceededError);
  });

  it('classifies overloaded_error body type as RateLimitError', () => {
    const error = makeAPIError(400, { type: 'overloaded_error', message: 'Service overloaded' });
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(RateLimitError);
  });

  it('falls through to message heuristics for unrecognised body type', () => {
    const error = makeAPIError(400, { type: 'unknown_error_type', message: 'Something went wrong' });
    const result = classifyAnthropicError(error);

    // No keyword match — returned as-is (the original APIError)
    expect(result).toBe(error);
  });
});

// ---------------------------------------------------------------------------
// Message heuristic fallback
// ---------------------------------------------------------------------------

describe('classifyAnthropicError — message heuristics (non-APIError)', () => {
  it('classifies "authentication" keyword as AuthenticationError', () => {
    const error = new Error('authentication failed');
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(AuthenticationError);
  });

  it('classifies "unauthorized" keyword as AuthenticationError', () => {
    const error = new Error('Unauthorized access');
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(AuthenticationError);
  });

  it('classifies "rate limit" keyword as RateLimitError', () => {
    const error = new Error('rate limit exceeded');
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(RateLimitError);
  });

  it('classifies "too many requests" keyword as RateLimitError', () => {
    const error = new Error('too many requests sent');
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(RateLimitError);
  });

  it('classifies "quota" keyword as QuotaExceededError', () => {
    const error = new Error('quota exceeded for this period');
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(QuotaExceededError);
  });

  it('classifies "credit" keyword as QuotaExceededError', () => {
    const error = new Error('insufficient credit balance');
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(QuotaExceededError);
  });

  it('classifies "model not found" keyword as ModelUnavailableError', () => {
    const error = new Error('model not found in registry');
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(ModelUnavailableError);
  });

  it('classifies "unknown model" keyword as ModelUnavailableError', () => {
    const error = new Error('unknown model identifier');
    const result = classifyAnthropicError(error);

    expect(result).toBeInstanceOf(ModelUnavailableError);
  });

  it('returns the original error when no keyword matches', () => {
    const error = new Error('something completely unrelated happened');
    const result = classifyAnthropicError(error);

    expect(result).toBe(error);
  });
});

// ---------------------------------------------------------------------------
// Non-Error input passthrough
// ---------------------------------------------------------------------------

describe('classifyAnthropicError — non-Error input', () => {
  it('wraps a plain string in a new Error', () => {
    const result = classifyAnthropicError('some string error');

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('some string error');
  });

  it('wraps a number in a new Error', () => {
    const result = classifyAnthropicError(500);

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('500');
  });

  it('wraps null in a new Error', () => {
    const result = classifyAnthropicError(null);

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('null');
  });
});

// ---------------------------------------------------------------------------
// Message preservation
// ---------------------------------------------------------------------------

describe('classifyAnthropicError — message preservation', () => {
  it('preserves the APIError message in the classified AuthenticationError', () => {
    const error = makeAPIError(401, { message: 'Invalid API key' });
    const result = classifyAnthropicError(error);

    // APIError.makeMessage formats as "${status} ${errorBody.message}"
    expect(result.message).toBe('401 Invalid API key');
  });

  it('preserves the APIError message in the classified RateLimitError for status 429', () => {
    const error = makeAPIError(429, { message: 'Too many requests' });
    const result = classifyAnthropicError(error);

    expect(result.message).toBe('429 Too many requests');
  });

  it('preserves the original message in the AuthenticationError from heuristic path', () => {
    const error = new Error('authentication required');
    const result = classifyAnthropicError(error);

    expect(result.message).toBe('authentication required');
  });
});
