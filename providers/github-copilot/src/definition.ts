import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for GitHub Copilot.
 *
 * SDK-only provider — GitHub Copilot communicates through its own proprietary
 * transport and does not expose a standard Anthropic or OpenAI HTTP endpoint.
 * The `endpoints` field is intentionally omitted. This is the reference
 * implementation for SDK-only providers.
 *
 * Credentials are resolved from `COPILOT_TOKEN`.
 */
export const providerDefinition: ProviderDefinitionInput = {
  id: 'github-copilot',
  name: 'GitHub Copilot',
  description: 'GitHub Copilot — premium request-based AI models',
  defaultModel: 'gpt-5.1-codex-mini',
  fastModel: 'gpt-5.4-mini',
  credentialEnvVars: { token: 'COPILOT_TOKEN' },
};
