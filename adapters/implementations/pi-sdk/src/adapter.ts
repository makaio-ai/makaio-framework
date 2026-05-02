import { AIAdapter, type AIAdapterConfig } from '@makaio/ai-adapters-core';
import { PiAgent } from './agent.js';
import { PiConnector } from './connector.js';
import { PiSdkNamespace } from './namespaces/index.js';
import type { PiSdkBus } from './namespaces/index.js';
import { PiSdkConfig } from './config.js';
import { PiSdkAdapterName } from './constants.js';

/**
 * Pi SDK Adapter — domain-level adapter using the three-layer architecture.
 *
 * Architecture:
 * ```
 * PiAdapter extends AIAdapter
 *     -> creates via agentFactory()
 * PiAgent extends AIAgent
 *     -> receives connector via connectorFactory()
 * PiConnector extends ProceduralAgentConnector
 * ```
 *
 * Responsibilities:
 * - Handle adapter.startAgent RPC (inherited from AIAdapter)
 * - Provide agent and connector factories for instance creation
 * - Emit adapter.initialized and adapter.session.created events
 * - Manage agent lifecycle (tracking, disposal)
 *
 * Pi SDK manages its own agentic loop — `session.prompt()` is procedural
 * and blocks until the full turn (including all tool calls) is complete.
 * Native tools (read, bash, edit, write, grep, find, ls) are handled
 * by the Pi SDK internally; Makaio acts as an orchestrator.
 * @example
 * ```typescript
 * // Using the class directly
 * const adapter = new PiAdapter();
 * await adapter.init();
 *
 * // Using the convenience factory
 * const adapter = await createPiSdkAdapter();
 * ```
 */
export class PiAdapter extends AIAdapter<PiSdkBus, PiConnector, PiAgent> {
  /**
   * Creates a Pi SDK adapter instance.
   * @param config - Optional adapter configuration overrides
   */
  public constructor(config?: Partial<AIAdapterConfig>) {
    super({
      ...config,
      name: PiSdkAdapterName,
      capabilities: ['tools', 'streaming', 'systemPrompt:override', 'systemPrompt:append', 'modelSwitchInSession'],
      nativeTools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
      namespace: PiSdkNamespace,
      agentFactory: (agentConfig) => new PiAgent(agentConfig),
      configFactory: PiSdkConfig.getConfig,
      connectorFactory: (fullConfig) => new PiConnector(fullConfig),
    });
  }
}

/**
 * Factory function to create and initialize a Pi SDK adapter.
 *
 * Convenience wrapper that creates the adapter and calls init() for you.
 * @param config - Optional adapter configuration
 * @returns Initialized PiAdapter instance
 * @example
 * ```typescript
 * const adapter = await createPiSdkAdapter();
 *
 * // Adapter is ready to handle requests via bus
 * // e.g., MakaioBus.request(AdapterSubjects.startAgent, { adapterId: adapter.adapterId, ... })
 * ```
 */
export async function createPiSdkAdapter(config?: Partial<AIAdapterConfig>): Promise<PiAdapter> {
  const adapter = new PiAdapter(config);
  await adapter.init();
  return adapter;
}
