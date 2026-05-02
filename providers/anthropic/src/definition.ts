import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for the official Anthropic Claude API.
 *
 * Communicates exclusively over the Anthropic Messages wire protocol
 * (`'anthropic'`). Credentials are resolved from `ANTHROPIC_API_KEY`.
 *
 * The model catalog is populated from the YAML lab registry at boot time by
 * the registry service — `availableModels` is intentionally omitted here.
 */
export const providerDefinition: ProviderDefinitionInput = {
  id: 'anthropic',
  name: 'Anthropic',
  description: 'Official Anthropic API',
  endpoints: { anthropic: 'https://api.anthropic.com' },
  defaultModel: 'claude-sonnet-4-6',
  fastModel: 'claude-haiku-4-5',
  credentialEnvVars: { apiKey: 'ANTHROPIC_API_KEY' },
};
