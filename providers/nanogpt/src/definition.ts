import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for NanoGPT.
 *
 * Communicates over the OpenAI Chat Completions wire protocol (`'openai'`).
 * Credentials are resolved from `NANOGPT_API_KEY`.
 *
 * `defaultModelFilterMode` is set to `'allowlist'` because this is a
 * specialized provider — models are hidden by default and must be explicitly
 * allowed.
 *
 * The model catalog is populated from the YAML lab registry at boot time by
 * the registry service — `availableModels` is intentionally omitted here.
 */
export const providerDefinition: ProviderDefinitionInput = {
  id: 'nanogpt',
  name: 'NanoGPT',
  description: 'NanoGPT - OpenAI-compatible API',
  endpoints: { openai: 'https://nano-gpt.com/api/v1' },
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
          sourceHints: [{ kind: 'environment', variable: 'NANOGPT_API_KEY' }],
        },
      ],
    },
  ],
};
