import { AIAdapter, type AIAdapterRuntimeConfig } from '@makaio/ai-adapters-core';
import { AnthropicSdkAgent } from './agent.js';
import { AnthropicSdkConnector } from './connector.js';
import { AnthropicSdkConnectorNamespace, type AnthropicSdkConnectorBus } from './namespaces/index.js';
import { AnthropicSdkConfig } from './config.js';
import { AnthropicSdkAdapterName } from './constants.js';

export { AnthropicSdkAdapterName };

/**
 * Anthropic SDK Adapter — Domain-level adapter using the three-layer architecture.
 *
 * Architecture:
 * ```
 * AnthropicSdkAdapter extends AIAdapter
 *     -> creates via agentFactory()
 * AnthropicSdkAgent extends AIAgent
 *     -> creates via connectorFactory()
 * AnthropicSdkConnector extends ProceduralAgentConnector
 * ```
 *
 * Responsibilities:
 * - Handle adapter.startAgent RPC (inherited from AIAdapter)
 * - Create AnthropicSdkAgent instances with proper configuration
 * - Emit adapter.initialized and adapter.session.created events
 * - Manage agent lifecycle (tracking, disposal)
 * @example
 * ```typescript
 * // Using the class directly
 * const adapter = new AnthropicSdkAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 * await adapter.init();
 *
 * // Using the convenience factory
 * const adapter = await createAnthropicSdkAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 * ```
 */
export class AnthropicSdkAdapter extends AIAdapter<AnthropicSdkConnectorBus, AnthropicSdkConnector, AnthropicSdkAgent> {
  public constructor(config: AIAdapterRuntimeConfig) {
    super({
      ...config,
      name: AnthropicSdkAdapterName,
      capabilities: ['tools', 'streaming', 'systemPrompt:override', 'systemPrompt:append', 'structuredOutput'],
      nativeTools: [],
      namespace: AnthropicSdkConnectorNamespace,
      agentFactory: (agentConfig) => {
        return new AnthropicSdkAgent(agentConfig);
      },
      configFactory: AnthropicSdkConfig.getConfig,
      connectorFactory: (fullConfig) => new AnthropicSdkConnector(fullConfig),
      definitionProviders: config.definitionProviders,
    });
  }
}

/**
 * Factory function to create and initialize an Anthropic SDK adapter.
 *
 * Convenience wrapper that creates the adapter and calls init() for you.
 * @param config - Runtime configuration, including the owning authority.
 * @returns Initialized AnthropicSdkAdapter instance
 * @example
 * ```typescript
 * const adapter = await createAnthropicSdkAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 *
 * // Adapter is ready to handle requests via bus
 * // e.g., MakaioBus.request(AdapterSubjects.startAgent, { adapterId: adapter.adapterId, ... })
 * ```
 */
export async function createAnthropicSdkAdapter(config: AIAdapterRuntimeConfig): Promise<AnthropicSdkAdapter> {
  const adapter = new AnthropicSdkAdapter(config);
  await adapter.init();
  return adapter;
}
