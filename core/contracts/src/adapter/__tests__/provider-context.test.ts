import { describe, expect, it } from 'vitest';
import { ProviderContextSchema } from '../schemas/provider-context.js';

const EXPLICIT_AUTH = {
  mode: 'explicit' as const,
  method: {
    owner: 'provider' as const,
    providerDefinitionId: 'anthropic',
    methodId: 'api-key',
  },
  definition: {
    id: 'api-key',
    mode: 'explicit' as const,
    label: 'API key',
    fields: [
      {
        id: 'apiKey',
        label: 'API key',
        required: true,
        secret: true,
        sourceHints: [{ kind: 'environment' as const, variable: 'ANTHROPIC_API_KEY' }],
      },
    ],
  },
  credentialRefs: { apiKey: 'env:ANTHROPIC_API_KEY' },
};

describe('ProviderContextSchema', () => {
  it('accepts a refs-only resolved context', () => {
    const result = ProviderContextSchema.safeParse({
      state: 'resolved',
      providerConfigId: 'anthropic-work',
      definitionId: 'anthropic',
      endpointOverrides: { anthropic: 'https://example.test' },
      auth: EXPLICIT_AUTH,
    });

    expect(result.success).toBe(true);
  });

  it('accepts only a closed configless shape for unresolved state', () => {
    expect(ProviderContextSchema.safeParse({ state: 'unresolved' }).success).toBe(true);
    expect(
      ProviderContextSchema.safeParse({
        state: 'unresolved',
        definitionId: 'anthropic',
      }).success,
    ).toBe(false);
  });

  it('rejects legacy top-level credential fields', () => {
    const result = ProviderContextSchema.safeParse({
      state: 'resolved',
      providerConfigId: 'anthropic-work',
      definitionId: 'anthropic',
      auth: EXPLICIT_AUTH,
      credentialRefs: { apiKey: 'env:ANTHROPIC_API_KEY' },
      credentialEnvVars: { apiKey: 'ANTHROPIC_API_KEY' },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a resolved context without normalized auth', () => {
    expect(
      ProviderContextSchema.safeParse({
        state: 'resolved',
        providerConfigId: 'anthropic-work',
        definitionId: 'anthropic',
      }).success,
    ).toBe(false);
  });

  it('rejects provider-owned auth from a different provider definition', () => {
    expect(
      ProviderContextSchema.safeParse({
        state: 'resolved',
        providerConfigId: 'anthropic-work',
        definitionId: 'other-provider',
        auth: EXPLICIT_AUTH,
      }).success,
    ).toBe(false);
  });
});
