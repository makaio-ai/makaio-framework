import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for the Google AI (Gemini) subscription (OAuth) provider.
 *
 * SDK-only provider — communicates through the Google AI SDK using credentials
 * managed by the account-manager or client binary rather than an API key. The
 * `endpoints` and `credentialEnvVars` fields are intentionally omitted.
 *
 * The model catalog is populated from the YAML lab registry at boot time by
 * the registry service — `availableModels` is intentionally omitted here.
 */
export const providerDefinitionOAuth: ProviderDefinitionInput = {
  id: 'google-oauth',
  name: 'Google AI (Subscription)',
  description: 'Google Gemini via OAuth subscription',
  defaultModel: 'gemini-2.5-pro',
  fastModel: 'gemini-2.5-flash',
};
