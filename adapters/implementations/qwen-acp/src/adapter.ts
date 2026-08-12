import { AIAdapter, type AIAdapterRuntimeConfig } from '@makaio/ai-adapters-core';
import { QwenAcpAgent } from './agent.js';
import { QwenAcpConnector } from './connector.js';
import { QwenAcpNamespace } from './namespaces/index.js';
import type { QwenAcpBus } from './namespaces/index.js';
import { QwenAcpConfig } from './config.js';
import { QwenAcpAdapterName } from './constants.js';

/**
 * Qwen ACP Adapter - Domain-level adapter using the three-layer architecture.
 *
 * Architecture:
 * ```
 * QwenAcpAdapter extends AIAdapter
 *     -> creates via agentFactory()
 * QwenAcpAgent extends AIAgent
 *     -> receives connector via connectorFactory()
 * QwenAcpConnector extends AIAgentConnector
 * ```
 *
 * Responsibilities:
 * - Handle adapter.startAgent RPC (inherited from AIAdapter)
 * - Provide agent and connector factories for instance creation
 * - Emit adapter.initialized and adapter.session.created events
 * - Manage agent lifecycle (tracking, disposal)
 *
 * ACP delegates all tool execution to the client (no nativeTools).
 * @example
 * ```typescript
 * // Using the class directly
 * const adapter = new QwenAcpAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 * await adapter.init();
 *
 * // Using the convenience factory
 * const adapter = await createQwenAcpAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 * ```
 */
export class QwenAcpAdapter extends AIAdapter<QwenAcpBus, QwenAcpConnector, QwenAcpAgent> {
  /**
   * Creates a Qwen ACP adapter instance.
   * @param config - Runtime configuration, including the owning authority.
   */
  public constructor(config: AIAdapterRuntimeConfig) {
    super({
      ...config,
      name: QwenAcpAdapterName,
      capabilities: ['tools', 'streaming', 'systemPrompt:override'],
      nativeTools: [], // ACP delegates all tool execution to the client
      namespace: QwenAcpNamespace,
      agentFactory: (agentConfig) => new QwenAcpAgent(agentConfig),
      configFactory: QwenAcpConfig.getConfig,
      connectorFactory: (fullConfig) => new QwenAcpConnector(fullConfig),
    });
  }
}

/**
 * Factory function to create and initialize a Qwen ACP adapter.
 *
 * Convenience wrapper that creates the adapter and calls init() for you.
 * @param config - Runtime configuration, including the owning authority.
 * @returns Initialized QwenAcpAdapter instance
 * @example
 * ```typescript
 * const adapter = await createQwenAcpAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 *
 * // Adapter is ready to handle requests via bus
 * // e.g., MakaioBus.request(AdapterSubjects.startAgent, { adapterId: adapter.adapterId, ... })
 * ```
 */
export async function createQwenAcpAdapter(config: AIAdapterRuntimeConfig): Promise<QwenAcpAdapter> {
  const adapter = new QwenAcpAdapter(config);
  await adapter.init();
  return adapter;
}
