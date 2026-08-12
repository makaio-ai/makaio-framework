import { AIAdapter, type AIAdapterRuntimeConfig } from '@makaio/ai-adapters-core';
import { CodexAppServerAgent } from './agent.js';
import { CodexAppServerConnector } from './connector.js';
import { CodexAppServerNamespace, type CodexAppServerBus } from './namespaces/index.js';
import { CodexAppServerConfig } from './config.js';
import { CodexAppServerAdapterName } from './constants.js';
import type { CodexAppServerConfig as CodexConnectorConfig } from './connector/types.js';

export { CodexAppServerAdapterName };

/**
 * Codex App-Server Adapter - Domain-level adapter using the three-layer architecture.
 *
 * Architecture:
 * ```
 * CodexAppServerAdapter extends AIAdapter
 *     -> creates via agentFactory()
 * CodexAppServerAgent extends AIAgent
 *     -> receives connector via connectorFactory()
 * CodexAppServerConnector extends AIAgentConnector
 * ```
 *
 * Responsibilities:
 * - Handle adapter.startAgent RPC (inherited from AIAdapter)
 * - Provide agent and connector factories for instance creation
 * - Emit adapter.initialized and adapter.session.created events
 * - Manage agent lifecycle (tracking, disposal)
 * @example
 * ```typescript
 * // Using the class directly
 * const adapter = new CodexAppServerAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 * await adapter.init();
 *
 * // Using the convenience factory
 * const adapter = await createCodexAppServerAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 * ```
 */
export class CodexAppServerAdapter extends AIAdapter<CodexAppServerBus, CodexAppServerConnector, CodexAppServerAgent> {
  public constructor(config: AIAdapterRuntimeConfig) {
    super({
      ...config,
      name: CodexAppServerAdapterName,
      capabilities: [
        'tools',
        'streaming',
        'systemPrompt:override',
        'systemPrompt:append',
        'structuredOutput',
        'session:resume',
        'session:fork',
      ],
      nativeTools: ['bash', 'patch'],
      namespace: CodexAppServerNamespace,
      agentFactory: (agentConfig) => {
        return new CodexAppServerAgent(agentConfig);
      },
      configFactory: CodexAppServerConfig.getConfig,
      connectorFactory: (fullConfig) => new CodexAppServerConnector(fullConfig as CodexConnectorConfig),
      definitionProviders: config.definitionProviders,
    });
  }
}

/**
 * Factory function to create and initialize a Codex App-Server adapter.
 *
 * Convenience wrapper that creates the adapter and calls init() for you.
 * @param config - Runtime configuration, including the owning authority.
 * @returns Initialized CodexAppServerAdapter instance
 * @example
 * ```typescript
 * const adapter = await createCodexAppServerAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 *
 * // Adapter is ready to handle requests via bus
 * // e.g., MakaioBus.request(AdapterSubjects.startAgent, { adapterId: adapter.adapterId, ... })
 * ```
 */
export async function createCodexAppServerAdapter(config: AIAdapterRuntimeConfig): Promise<CodexAppServerAdapter> {
  const adapter = new CodexAppServerAdapter(config);
  await adapter.init();
  return adapter;
}
