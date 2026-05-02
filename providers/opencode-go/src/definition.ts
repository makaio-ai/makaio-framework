import type { ProviderDefinitionInput } from '@makaio/contracts';

/** Base URL shared by both OpenCode Go protocol endpoints. */
const BASE_URL = 'https://opencode.ai/zen/go/v1';

/**
 * Provider definition for OpenCode Go — OpenAI-compatible protocol.
 *
 * Covers the models available via the `/chat/completions` endpoint.
 * The OpenAI SDK appends `/chat/completions` to the base URL automatically.
 *
 * Credentials are resolved from `OPENCODE_GO_API_KEY`.
 *
 * The model catalog is populated from the YAML lab registry at boot time by
 * the registry service — `availableModels` is intentionally omitted here.
 */
export const openaiProviderDefinition: ProviderDefinitionInput = {
  id: 'opencode-go',
  name: 'OpenCode Go',
  description: 'OpenCode Go gateway — OpenAI compatible API',
  endpoints: {
    openai: BASE_URL,
  },
  defaultModel: 'kimi-k2.5',
  fastModel: 'glm-5.1',
  defaultModelFilterMode: 'allowlist',
  credentialEnvVars: { apiKey: 'OPENCODE_GO_API_KEY' },
};

/**
 * Provider definition for OpenCode Go — Anthropic-compatible protocol.
 *
 * Covers the models available via the `/messages` endpoint.
 * The Anthropic SDK appends `/messages` to the base URL automatically.
 *
 * Credentials are resolved from `OPENCODE_GO_API_KEY`.
 *
 * The model catalog is populated from the YAML lab registry at boot time by
 * the registry service — `availableModels` is intentionally omitted here.
 */
export const anthropicProviderDefinition: ProviderDefinitionInput = {
  id: 'opencode-go-anthropic',
  name: 'OpenCode Go (Anthropic)',
  description: 'OpenCode Go gateway — Anthropic compatible API',
  endpoints: {
    // Anthropic SDK appends `/v1/messages` to baseURL, so omit the trailing `/v1`.
    anthropic: 'https://opencode.ai/zen/go',
  },
  defaultModel: 'minimax-m2.5',
  fastModel: 'minimax-m2.7',
  defaultModelFilterMode: 'allowlist',
  credentialEnvVars: { apiKey: 'OPENCODE_GO_API_KEY' },
};
