import type { ProviderContext } from '@makaio/contracts';

/**
 * Build a resolved provider context that deliberately requires no authentication.
 * @param providerConfigId - Provider config identity for the test
 * @param definitionId - Provider definition identity for the test
 * @returns Fresh normalized no-auth provider context
 */
export function createNoAuthTestProviderContext(
  providerConfigId = 'test-provider-config',
  definitionId = 'test-provider',
): ProviderContext {
  return {
    state: 'resolved',
    providerConfigId,
    definitionId,
    auth: {
      mode: 'none',
      method: { owner: 'provider', providerDefinitionId: definitionId, methodId: 'none' },
      definition: { id: 'none', mode: 'none', label: 'No authentication' },
    },
  };
}
