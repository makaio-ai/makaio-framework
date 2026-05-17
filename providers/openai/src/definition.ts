import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for the official OpenAI API.
 *
 * Communicates over the OpenAI Chat Completions wire protocol (`'openai'`).
 * Credentials are resolved from `OPENAI_API_KEY`.
 *
 * The model catalog and OpenAI reasoning-effort mappings are populated from
 * `providers/labs/openai.yaml` and `providers/providers/openai.yaml` at boot.
 */
export const providerDefinition: ProviderDefinitionInput = {
  id: 'openai',
  name: 'OpenAI',
  description: 'Official OpenAI API',
  endpoints: { openai: 'https://api.openai.com/v1' },
  defaultModel: 'gpt-5.2',
  fastModel: 'gpt-5.4-mini',
  credentialEnvVars: { apiKey: 'OPENAI_API_KEY' },
};
