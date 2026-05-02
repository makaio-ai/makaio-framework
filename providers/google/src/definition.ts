import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for the official Google AI (Gemini) API.
 *
 * SDK-only provider — Google Gemini communicates through the Google AI SDK
 * with OAuth-based authentication and does not expose a standard Anthropic or
 * OpenAI HTTP endpoint. The `endpoints` field is intentionally omitted.
 * Credentials are resolved from `GEMINI_API_KEY`.
 *
 * The model catalog is populated from the YAML lab registry at boot time by
 * the registry service — `availableModels` is intentionally omitted here.
 */
export const providerDefinition: ProviderDefinitionInput = {
  id: 'google',
  name: 'Google AI',
  description: 'Official Google AI API',
  defaultModel: 'gemini-2.5-pro',
  fastModel: 'gemini-2.5-flash',
  credentialEnvVars: { apiKey: 'GEMINI_API_KEY' },
};
