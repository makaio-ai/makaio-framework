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

/**
 * Build a provider context whose native account the adapter must activate.
 *
 * Activation only runs for a resolved context in `inferred` auth mode that names
 * an account — every other shape skips it — so a case about the activation step
 * has to say so precisely rather than by hoping the default qualifies.
 * @param account - Native account the context selects.
 * @param providerConfigId - Provider config identifier.
 * @param definitionId - Provider definition identifier.
 * @returns A context that requires account activation.
 */
export function createManagedAccountTestProviderContext(
  account: { managerId: string; accountId: string } = { managerId: 'test-manager', accountId: 'test-account' },
  providerConfigId = 'test-provider-config',
  definitionId = 'test-provider',
): ProviderContext {
  return {
    state: 'resolved',
    providerConfigId,
    definitionId,
    auth: {
      mode: 'inferred',
      method: { owner: 'client', clientId: definitionId, methodId: 'native' },
      definition: { id: 'native', mode: 'inferred', label: 'Native account' },
      account,
    },
  };
}
