import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for OpenAI Codex (App-Server).
 *
 * Subprocess-based provider — Codex communicates through the Codex app-server
 * binary via a local subprocess and does not expose a network HTTP endpoint.
 * The `endpoints` field is intentionally omitted.
 * API-key credentials may be sourced from `OPENAI_API_KEY` for explicit
 * delivery through the app-server login protocol.
 *
 * The model catalog is populated from the YAML lab registry at boot time by
 * the registry service — `availableModels` is intentionally omitted here.
 */
export const providerDefinition: ProviderDefinitionInput = {
  id: 'openai-codex',
  name: 'OpenAI Codex',
  description: 'OpenAI Codex App-Server',
  defaultModel: 'gpt-5.5',
  fastModel: 'gpt-5.4-mini',
  primaryTestModel: 'gpt-5.4-mini',
  secondaryTestModel: 'gpt-5.3-codex',
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
          sourceHints: [{ kind: 'environment', variable: 'OPENAI_API_KEY' }],
        },
      ],
    },
  ],
};
