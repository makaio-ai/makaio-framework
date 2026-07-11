import { defineAdapterProviderAuth } from '@makaio/contracts';

/**
 * Create validated adapter/provider auth metadata for a provider-owned API-key method.
 * @param providerDefinitionId - Provider definition that owns the test method.
 * @returns Validated auth metadata suitable for resolved provider fixtures.
 */
export function createTestProviderAuth(providerDefinitionId: string) {
  return defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'provider', providerDefinitionId, methodId: 'api-key' },
        deliveries: [{ kind: 'process-env', fields: { apiKey: 'TEST_PROVIDER_API_KEY' } }],
      },
    ],
    scrubEnvVars: ['TEST_PROVIDER_API_KEY'],
  });
}
