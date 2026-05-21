import { describe, expect, it } from 'vitest';
import { JsonValueSchema } from '../json-value.js';

describe('JsonValueSchema', () => {
  it('accepts nested JSON-safe values', () => {
    expect(
      JsonValueSchema.safeParse({
        enabled: true,
        retries: 3,
        labels: ['alpha', 'beta'],
        nested: {
          value: null,
          config: {
            endpoint: 'https://example.test',
          },
        },
      }).success,
    ).toBe(true);
  });

  it('rejects non-JSON runtime values', () => {
    expect(JsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(JsonValueSchema.safeParse(new Map()).success).toBe(false);
    expect(JsonValueSchema.safeParse(() => 'nope').success).toBe(false);
    expect(JsonValueSchema.safeParse({ nested: { invalid: undefined } }).success).toBe(false);
  });
});
