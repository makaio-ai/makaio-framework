import { describe, expect, it } from 'vitest';

import { parseResultError } from '../parseResultError.js';

describe('parseResultError', () => {
  it('uses SDK error details for native structured-output retry exhaustion', () => {
    const error = parseResultError({
      subtype: 'error_max_structured_output_retries',
      is_error: true,
      errors: ['Structured output retry limit reached: missing required property "ok"'],
      stop_reason: null,
    });

    expect(error).toBe('Structured output retry limit reached: missing required property "ok"');
  });
});
