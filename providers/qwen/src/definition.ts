import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for Qwen OAuth.
 *
 * Subprocess-based provider — Qwen Code communicates through the Qwen Code CLI
 * via the Agent Client Protocol (ACP) subprocess and does not expose a network
 * HTTP endpoint. The `endpoints` field is intentionally omitted.
 *
 * The model catalog is populated from the YAML lab registry at boot time by
 * the registry service — `availableModels` is intentionally omitted here.
 */
export const providerDefinition: ProviderDefinitionInput = {
  id: 'qwen-oauth',
  name: 'Qwen OAuth',
  description: 'Qwen Code CLI via Agent Client Protocol',
  defaultModel: 'qwen3.5-plus(openai)',
  fastModel: 'qwen3-coder-plus(openai)',
  authMethods: [],
};
