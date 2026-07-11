import { describe, expect, it } from 'vitest';
import { ProviderConfigSchema, ProviderDefaultsSchema } from '../provider-defaults.js';

describe('ProviderDefaultsSchema normalized auth boundary', () => {
  it('rejects legacy credential maps instead of stripping them', () => {
    expect(
      ProviderDefaultsSchema.safeParse({
        credentials: { apiKey: 'env:ANTHROPIC_API_KEY' },
      }).success,
    ).toBe(false);
    expect(
      ProviderConfigSchema.safeParse({
        name: 'Anthropic',
        credentials: { apiKey: 'env:ANTHROPIC_API_KEY' },
      }).success,
    ).toBe(false);
  });
});
