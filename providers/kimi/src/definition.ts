import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for Kimi.
 *
 * Communicates over the Anthropic Messages wire protocol (`'anthropic'`).
 * Credentials are resolved from `KIMI_API_KEY`.
 *
 * The model catalog is populated from the YAML lab registry at boot time by
 * the registry service — `availableModels` is intentionally omitted here.
 */
export const providerDefinition: ProviderDefinitionInput = {
  id: 'kimi',
  name: 'Kimi',
  description: 'Kimi - Anthropic-compatible API',
  // Endpoint matches the production adapter preset (claude-agent-sdk/src/provider.ts).
  // api.kimi.com/coding is the coding-specific Anthropic-compatible endpoint,
  // distinct from the general Moonshot API at api.moonshot.ai.
  endpoints: { anthropic: 'https://api.kimi.com/coding' },
  defaultModel: 'kimi-k2.5',
  fastModel: 'kimi-k2.5',
  credentialEnvVars: { apiKey: 'KIMI_API_KEY' },
};
