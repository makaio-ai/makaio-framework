import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for the Anthropic Claude subscription (OAuth) provider.
 *
 * SDK-only provider — communicates through the Anthropic SDK using credentials
 * managed by the account-manager or client binary rather than an API key. The
 * `endpoints` and `credentialEnvVars` fields are intentionally omitted.
 *
 * The model catalog is populated from the YAML lab registry at boot time by
 * the registry service — `availableModels` is intentionally omitted here.
 */
export const providerDefinitionOAuth: ProviderDefinitionInput = {
  id: 'anthropic-oauth',
  name: 'Anthropic (Subscription)',
  description: 'Anthropic Claude via OAuth subscription',
  defaultModel: 'sonnet',
  fastModel: 'haiku',
};
