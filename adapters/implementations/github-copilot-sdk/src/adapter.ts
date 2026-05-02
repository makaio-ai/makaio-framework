import { AIAdapter, type AIAdapterConfig } from '@makaio/ai-adapters-core';
import { GitHubCopilotAgent } from './agent.js';
import { GitHubCopilotConnectorNamespace, type GitHubCopilotConnectorBus } from './namespaces/index.js';
import { GitHubCopilotConnector } from './connector.js';
import { GitHubCopilotConfig } from './config.js';
import { GitHubCopilotSdkAdapterName } from './constants.js';

export { GitHubCopilotSdkAdapterName };

/**
 * GitHub Copilot SDK Adapter - Domain-level adapter using the three-layer architecture.
 *
 * Architecture:
 * ```
 * GitHubCopilotAdapter extends AIAdapter
 *     -> creates via createAgent()
 * GitHubCopilotAgent extends AIAgent
 *     -> creates via createConnector()
 * GitHubCopilotConnector extends AIAgentConnector
 * ```
 *
 * Responsibilities:
 * - Handle adapter.startAgent RPC (inherited from AIAdapter)
 * - Create GitHubCopilotAgent instances with proper configuration
 * - Emit adapter.initialized and adapter.session.created events
 * - Manage agent lifecycle (tracking, disposal)
 * @example
 * ```typescript
 * // Using the class directly
 * const adapter = new GitHubCopilotAdapter();
 * await adapter.init();
 *
 * // Using the convenience factory
 * const adapter = await createGitHubCopilotSDKAdapter();
 * ```
 */
export class GitHubCopilotAdapter extends AIAdapter<
  GitHubCopilotConnectorBus,
  GitHubCopilotConnector,
  GitHubCopilotAgent
> {
  public constructor(config?: Partial<AIAdapterConfig>) {
    super({
      name: GitHubCopilotSdkAdapterName,
      capabilities: ['tools', 'systemPrompt:override', 'systemPrompt:append'],
      ...config,
      namespace: GitHubCopilotConnectorNamespace,
      agentFactory: (agentConfig) => {
        return new GitHubCopilotAgent(agentConfig);
      },
      configFactory: GitHubCopilotConfig.getConfig,
      connectorFactory: (fullConfig) => new GitHubCopilotConnector(fullConfig),
      definitionProviders: config?.definitionProviders,
    });
  }
}

/**
 * Factory function to create and initialize a GitHub Copilot SDK adapter.
 *
 * Convenience wrapper that creates the adapter and calls init() for you.
 * @param config - Optional adapter configuration
 * @returns Initialized GitHubCopilotAdapter instance
 * @example
 * ```typescript
 * const adapter = await createGitHubCopilotSDKAdapter();
 *
 * // Adapter is ready to handle requests via bus
 * // e.g., MakaioBus.request(AdapterSubjects.startAgent, { adapterId: adapter.adapterId, ... })
 * ```
 */
export async function createGitHubCopilotSDKAdapter(config?: Partial<AIAdapterConfig>): Promise<GitHubCopilotAdapter> {
  const adapter = new GitHubCopilotAdapter(config);
  await adapter.init();
  return adapter;
}
