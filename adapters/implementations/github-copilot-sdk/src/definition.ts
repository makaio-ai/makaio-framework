/**
 * Adapter definition for GitHub Copilot SDK
 * Separate file to avoid circular dependency with config.ts
 */
import type { AIAdapterDefinition } from '@makaio/ai-adapters-core';
import { createGitHubCopilotSDKAdapter } from './adapter.js';
import { GitHubCopilotSdkAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { GitHubCopilotSdkProviderConfigSchema } from './schemas.js';
import type { GitHubCopilotConnectorBus } from './namespaces/index.js';
import type { GitHubCopilotConnector } from './connector.js';
import type { GitHubCopilotAgent } from './agent.js';
import { defaultPresetId, providerAuthById, providerIds } from './provider.js';

/**
 * GitHub Copilot adapter definition.
 *
 * Note: GitHub Copilot SDK does not provide a models discovery endpoint.
 * Available models must be configured statically in the provider config's
 * availableModels field. Each model must include contextWindowSize.
 */
export const adapterDefinition: AIAdapterDefinition<
  GitHubCopilotConnectorBus,
  GitHubCopilotConnector,
  GitHubCopilotAgent
> = {
  name: GitHubCopilotSdkAdapterName,
  displayName: 'GitHub Copilot',
  defaultPresetId,
  description: 'GitHub Copilot SDK integration',
  providers: providerIds.map((definitionId) => ({ definitionId, auth: providerAuthById[definitionId] })),
  providerConfigSchema: GitHubCopilotSdkProviderConfigSchema,
  defaultTimeouts: DEFAULT_TIMEOUTS,
  helpLinks: [{ label: 'GitHub Copilot', url: 'https://github.com/features/copilot' }],
  clients: [{ id: 'github-copilot', version: '^0.1.0' }],
  instructions: `Use GitHub Copilot for AI-powered code suggestions.

1. Ensure you have an active GitHub Copilot subscription
2. Configure max messages for conversation history
3. Optionally enable debug mode

**Note:** GitHub Copilot does not provide a models API. Available models must be
configured in your provider config with contextWindowSize for each model.`,
  createAdapter: createGitHubCopilotSDKAdapter,
};
