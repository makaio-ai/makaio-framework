import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for OpenRouter.
 *
 * Communicates over the OpenAI Chat Completions wire protocol (`'openai'`).
 * Credentials are resolved from `OPENROUTER_API_KEY`.
 *
 * `defaultModelFilterMode` is set to `'allowlist'` because OpenRouter is a
 * firehose provider — it proxies 300+ models from many labs. Models are hidden
 * by default and must be explicitly allowed.
 *
 * The model catalog is populated from the YAML lab registry at boot time by
 * the registry service — `availableModels` is intentionally omitted here.
 */
export const providerDefinition: ProviderDefinitionInput = {
  id: 'openrouter',
  name: 'OpenRouter',
  description: 'OpenRouter — unified API for 300+ AI models across providers.',
  endpoints: { openai: 'https://openrouter.ai/api/v1' },
  defaultModelFilterMode: 'allowlist',
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
          sourceHints: [{ kind: 'environment', variable: 'OPENROUTER_API_KEY' }],
        },
      ],
    },
  ],
};
