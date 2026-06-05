import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for Cursor.
 *
 * SDK-only provider — Cursor communicates through its own proprietary
 * transport and does not expose a standard Anthropic or OpenAI HTTP endpoint.
 * The `endpoints` field is intentionally omitted. This follows the same
 * pattern as the GitHub Copilot SDK-only provider reference implementation.
 *
 * Credentials are resolved from `CURSOR_API_KEY`.
 */
export const providerDefinition: ProviderDefinitionInput = {
  id: 'cursor',
  name: 'Cursor',
  description: 'Cursor — SDK-based AI models',
  defaultModel: 'composer-2.5',
  fastModel: 'composer-2',
  credentialEnvVars: { apiKey: 'CURSOR_API_KEY' },
};
