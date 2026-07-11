import { describe, expect, it } from 'vitest';
import { defineAdapterProviderAuth, type AdapterProviderRef, type ProviderDefinitionInput } from '@makaio/contracts';
import { createMockScopedBus } from '@makaio/test-utils';
import { createTestProviderContext, resolveTestConfig } from '../resolveTestConfig.js';

/**
 * Build one explicit provider definition for normalized conformance config tests.
 * @param id - Provider definition identifier
 * @param envVar - API-key environment source
 * @returns Provider definition with one explicit API-key method
 */
function providerDefinition(id: string, envVar: string): ProviderDefinitionInput {
  return {
    id,
    name: id,
    defaultModel: `${id}-model`,
    authMethods: [
      {
        id: 'api-key',
        mode: 'explicit',
        label: 'API key',
        fields: [
          {
            id: 'apiKey',
            label: 'API key',
            required: true,
            secret: true,
            sourceHints: [{ kind: 'environment', variable: envVar }],
          },
        ],
      },
    ],
  };
}

/**
 * Build one exact connector auth declaration for a provider definition.
 * @param definitionId - Provider definition identifier
 * @param target - Connector delivery target
 * @returns Adapter/provider auth declaration
 */
function providerAuth(definitionId: string, target: string) {
  return defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'provider', providerDefinitionId: definitionId, methodId: 'api-key' },
        deliveries: [{ kind: 'connector', target, fields: { apiKey: 'apiKey' } }],
      },
    ],
    scrubEnvVars: ['PROVIDER_A_API_KEY', 'PROVIDER_B_API_KEY'],
  });
}

describe('resolveTestConfig adapter/provider selection', () => {
  it('derives protocol and auth only from the selected adapter provider ref', () => {
    const providerA = providerDefinition('provider-a', 'PROVIDER_A_API_KEY');
    const providerB = providerDefinition('provider-b', 'PROVIDER_B_API_KEY');
    const authA = providerAuth('provider-a', 'provider-a.constructor');
    const authB = providerAuth('provider-b', 'provider-b.constructor');
    const refs = [
      { definitionId: 'provider-a', protocol: 'anthropic', auth: authA },
      { definitionId: 'provider-b', protocol: 'openai', auth: authB },
    ] satisfies AdapterProviderRef[];
    const providerContext = createTestProviderContext(providerB);
    const { bus } = createMockScopedBus();

    const result = resolveTestConfig({ providerContext }, bus, providerA, refs);

    expect(result.providerProtocol).toBe('openai');
    expect(result.adapterProviderAuth).toBe(authB);
    expect(result.compatibleProviderAuths).toEqual([authA]);
  });

  it('does not invent a protocol for an SDK-native provider ref', () => {
    const provider = providerDefinition('provider-sdk', 'PROVIDER_SDK_API_KEY');
    const auth = providerAuth('provider-sdk', 'provider-sdk.constructor');
    const { bus } = createMockScopedBus();

    const result = resolveTestConfig({ providerContext: createTestProviderContext(provider) }, bus, provider, [
      { definitionId: provider.id, auth },
    ]);

    expect(result).not.toHaveProperty('providerProtocol');
    expect(result.adapterProviderAuth).toBe(auth);
  });
});
