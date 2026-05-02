import { AIAdapter, type AIAdapterConfig } from '@makaio/ai-adapters-core';
import { GeminiAgent } from './agent.js';
import { GeminiConnector } from './connector.js';
import { GeminiConnectorNamespace, type GeminiConnectorBus } from './namespaces/index.js';
import { GeminiSdkConfig } from './config.js';
import { GeminiSdkAdapterName } from './constants.js';

export { GeminiSdkAdapterName };

/**
 * Gemini SDK Adapter - Domain-level adapter using the three-layer architecture.
 *
 * Architecture:
 * ```
 * GeminiAdapter extends AIAdapter
 *     -> creates via agentFactory
 * GeminiAgent extends AIAgent
 *     -> creates via connectorFactory
 * GeminiConnector extends AIAgentConnector
 * ```
 *
 * Responsibilities:
 * - Handle adapter.startAgent RPC (inherited from AIAdapter)
 * - Create GeminiAgent instances with proper configuration
 * - Emit adapter.initialized and adapter.session.created events
 * - Manage agent lifecycle (tracking, disposal)
 * @example
 * ```typescript
 * // Using the class directly
 * const adapter = new GeminiAdapter();
 * await adapter.init();
 *
 * // Using the convenience factory
 * const adapter = await createGeminiSDKAdapter();
 * ```
 */
export class GeminiAdapter extends AIAdapter<GeminiConnectorBus, GeminiConnector, GeminiAgent> {
  public constructor(config?: Partial<AIAdapterConfig>) {
    super({
      name: GeminiSdkAdapterName,
      capabilities: ['tools', 'streaming', 'systemPrompt:override', 'systemPrompt:append'],
      ...config,
      namespace: GeminiConnectorNamespace,
      agentFactory: (agentConfig) => {
        return new GeminiAgent(agentConfig);
      },
      configFactory: GeminiSdkConfig.getConfig,
      connectorFactory: (fullConfig) => new GeminiConnector(fullConfig),
      definitionProviders: config?.definitionProviders,
    });
  }
}

/**
 * Factory function to create and initialize a Gemini SDK adapter.
 *
 * Convenience wrapper that creates the adapter and calls init() for you.
 * @param config - Optional adapter configuration
 * @returns Initialized GeminiAdapter instance
 * @example
 * ```typescript
 * const adapter = await createGeminiSDKAdapter();
 *
 * // Adapter is ready to handle requests via bus
 * // e.g., MakaioBus.request(AdapterSubjects.startAgent, { adapterId: adapter.adapterId, ... })
 * ```
 */
export async function createGeminiSDKAdapter(config?: Partial<AIAdapterConfig>): Promise<GeminiAdapter> {
  const adapter = new GeminiAdapter(config);
  await adapter.init();
  return adapter;
}
