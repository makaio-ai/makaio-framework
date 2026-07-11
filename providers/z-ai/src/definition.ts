import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for Z.AI (GLM).
 *
 * Dual-protocol provider that exposes both an Anthropic-compatible and an
 * OpenAI-compatible inference endpoint. This is the reference implementation
 * for multi-protocol providers — the two `endpoints` entries let adapters
 * choose whichever wire protocol they support.
 *
 * Credentials are resolved from `Z_AI_API_KEY`.
 *
 * The model catalog is populated from the YAML lab registry at boot time by
 * the registry service — `availableModels` is intentionally omitted here.
 */
export const providerDefinition: ProviderDefinitionInput = {
  id: 'z-ai',
  name: 'Z.AI (GLM)',
  description: 'Z.AI — Anthropic and OpenAI compatible API',
  endpoints: {
    anthropic: 'https://api.z.ai/api/anthropic',
    openai: 'https://api.z.ai/api/openai',
  },
  defaultModel: 'glm-4.7',
  fastModel: 'glm-4.7',
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
          sourceHints: [{ kind: 'environment', variable: 'Z_AI_API_KEY' }],
        },
      ],
    },
  ],
};
