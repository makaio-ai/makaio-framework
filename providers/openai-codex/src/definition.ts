import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for OpenAI Codex (App-Server).
 *
 * Subprocess-based provider — Codex communicates through the Codex app-server
 * binary via a local subprocess and does not expose a network HTTP endpoint.
 * The `endpoints` field is intentionally omitted.
 *
 * The model catalog is populated from the YAML lab registry at boot time by
 * the registry service — `availableModels` is intentionally omitted here.
 */
export const providerDefinition: ProviderDefinitionInput = {
  id: 'openai-codex',
  name: 'OpenAI Codex',
  description: 'OpenAI Codex App-Server',
  defaultModel: 'gpt-5.1-codex-mini',
  fastModel: 'gpt-5.4-mini',
};
