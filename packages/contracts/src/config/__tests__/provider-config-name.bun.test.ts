import { describe, expect, it } from 'bun:test';
import { resolveCanonicalProviderConfigName } from '../provider-config-name.js';

describe('resolveCanonicalProviderConfigName', () => {
  it('prefers the explicit requested name', () => {
    expect(
      resolveCanonicalProviderConfigName({
        requestedName: '  Anthropic Work  ',
        providerName: 'Anthropic API',
        definitionId: 'anthropic',
      }),
    ).toBe('Anthropic Work');
  });

  it('falls back to the provider definition display name when canonical', () => {
    expect(
      resolveCanonicalProviderConfigName({
        providerName: 'Anthropic API',
        definitionId: 'anthropic-sdk',
      }),
    ).toBe('Anthropic API');
  });

  it('falls back to the definition id when the provider name is not canonical', () => {
    expect(
      resolveCanonicalProviderConfigName({
        providerName: 'Anthropic/API',
        definitionId: 'anthropic',
      }),
    ).toBe('anthropic');
  });

  it('returns undefined when no canonical candidate exists', () => {
    expect(
      resolveCanonicalProviderConfigName({
        providerName: 'Anthropic/API',
        definitionId: 'anthropic::sdk',
      }),
    ).toBeUndefined();
  });
});
