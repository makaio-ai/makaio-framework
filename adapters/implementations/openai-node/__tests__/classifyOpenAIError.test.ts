import { AuthenticationError, ModelUnavailableError, QuotaExceededError, RateLimitError } from '@makaio/core';
import { describe, expect, it } from 'vitest';
import { classifyOpenAIError } from '../src/utils/classifyOpenAIError.js';

describe('classifyOpenAIError', () => {
  it('maps 401 and 403 to AuthenticationError', () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { status: 401 });
    const forbidden = Object.assign(new Error('Forbidden'), { status: 403 });

    expect(classifyOpenAIError(unauthorized)).toBeInstanceOf(AuthenticationError);
    expect(classifyOpenAIError(forbidden)).toBeInstanceOf(AuthenticationError);
  });

  it('maps 404 model errors to ModelUnavailableError', () => {
    const byMessage = Object.assign(new Error('Model not found'), { status: 404 });
    const byCode = Object.assign(new Error('Not found'), { status: 404, code: 'model_not_found' });

    expect(classifyOpenAIError(byMessage)).toBeInstanceOf(ModelUnavailableError);
    expect(classifyOpenAIError(byCode)).toBeInstanceOf(ModelUnavailableError);
  });

  it('maps 429 quota-related errors to QuotaExceededError', () => {
    const quotaInMessage = Object.assign(new Error('Quota exceeded'), { status: 429 });
    const quotaCode = Object.assign(new Error('Too many requests'), { status: 429, code: 'insufficient_quota' });

    expect(classifyOpenAIError(quotaInMessage)).toBeInstanceOf(QuotaExceededError);
    expect(classifyOpenAIError(quotaCode)).toBeInstanceOf(QuotaExceededError);
  });

  it('maps 429 non-quota errors to RateLimitError', () => {
    const rateLimit = Object.assign(new Error('Rate limit reached'), { status: 429 });

    expect(classifyOpenAIError(rateLimit)).toBeInstanceOf(RateLimitError);
  });

  it('maps fallback patterns when status is absent', () => {
    const quotaByType = Object.assign(new Error('Error'), { type: 'insufficient_quota' });
    const rateByCode = Object.assign(new Error('Error'), { code: 'rate_limit_exceeded' });
    const authByMessage = Object.assign(new Error('Authentication failed'));

    expect(classifyOpenAIError(quotaByType)).toBeInstanceOf(QuotaExceededError);
    expect(classifyOpenAIError(rateByCode)).toBeInstanceOf(RateLimitError);
    expect(classifyOpenAIError(authByMessage)).toBeInstanceOf(AuthenticationError);
  });

  it('returns original Error when unclassified', () => {
    const original = Object.assign(new Error('Unhandled'));
    expect(classifyOpenAIError(original)).toBe(original);
  });

  it('converts non-Error values to Error', () => {
    const result = classifyOpenAIError('plain failure');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain('plain failure');
  });
});
