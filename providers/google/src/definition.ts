import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for the official Google AI (Gemini) API.
 *
 * SDK-only provider — Google Gemini communicates through the Google AI SDK
 * and does not expose a standard Anthropic or OpenAI HTTP endpoint. The
 * `endpoints` field is intentionally omitted. Credentials are resolved from
 * `GEMINI_API_KEY`.
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
          sourceHints: [{ kind: 'environment', variable: 'GEMINI_API_KEY' }],
        },
      ],
    },
  ],
};
