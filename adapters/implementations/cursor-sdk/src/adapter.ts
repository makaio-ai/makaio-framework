/**
 * Cursor SDK Adapter — domain-level adapter using the three-layer architecture.
 *
 * Architecture:
 * ```
 * CursorSdkAdapter extends AIAdapter
 *     -> creates via agentFactory()
 * CursorSdkAgent extends AIAgent
 *     -> receives connector via connectorFactory()
 * CursorSdkConnector extends ProceduralAgentConnector
 * ```
 *
 * Responsibilities:
 * - Handle adapter.startAgent RPC (inherited from AIAdapter)
 * - Provide agent and connector factories for instance creation
 * - Emit adapter.initialized and adapter.session.created events
 * - Manage agent lifecycle (tracking, disposal)
 *
 * Cursor SDK manages its own agentic loop — `agent.send()` streams events
 * asynchronously until the full turn (including all tool calls) is complete.
 * Tools are opaque to Makaio — Cursor routes tool execution internally through
 * its registered MCP servers. This adapter does NOT declare `nativeTools`.
 * @example
 * ```typescript
 * // Using the class directly
 * const adapter = new CursorSdkAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 * await adapter.init();
 *
 * // Using the convenience factory
 * const adapter = await createCursorSdkAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 * ```
 */

import { AIAdapter, type AIAdapterRuntimeConfig } from '@makaio/ai-adapters-core';
import type { CursorSdkBus } from './namespaces/index.js';
import { CursorSdkNamespace } from './namespaces/index.js';
import { CursorSdkAdapterName } from './constants.js';
import { CursorSdkConfig } from './config.js';
import { CursorSdkConnector } from './connector.js';
import { CursorSdkAgent } from './agent.js';

/**
 * Cursor SDK Adapter — orchestrates agent creation and lifecycle.
 *
 * Wraps the Cursor SDK's `Agent` class in Makaio's three-layer adapter model.
 * Cursor's tools are opaque to the framework (routed via MCP bridge), so no
 * `nativeTools` declaration is made here.
 */
export class CursorSdkAdapter extends AIAdapter<CursorSdkBus, CursorSdkConnector, CursorSdkAgent> {
  /**
   * Creates a Cursor SDK adapter instance.
   * @param config - Runtime configuration, including the owning authority.
   */
  public constructor(config: AIAdapterRuntimeConfig) {
    super({
      ...config,
      name: CursorSdkAdapterName,
      capabilities: ['tools', 'streaming', 'modelSwitchInSession', 'session:resume'],
      nativeTools: [],
      namespace: CursorSdkNamespace,
      agentFactory: (agentConfig) => new CursorSdkAgent(agentConfig),
      configFactory: CursorSdkConfig.getConfig,
      connectorFactory: (connectorConfig) => new CursorSdkConnector(connectorConfig),
    });
  }
}

/**
 * Factory function to create and initialize a Cursor SDK adapter.
 *
 * Convenience wrapper that creates the adapter and calls init() for you.
 * @param config - Runtime configuration, including the owning authority.
 * @returns Initialized CursorSdkAdapter instance
 * @example
 * ```typescript
 * const adapter = await createCursorSdkAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
 *
 * // Adapter is ready to handle requests via bus
 * // e.g., MakaioBus.request(AdapterSubjects.startAgent, { adapterId: adapter.adapterId, ... })
 * ```
 */
export async function createCursorSdkAdapter(config: AIAdapterRuntimeConfig): Promise<CursorSdkAdapter> {
  const adapter = new CursorSdkAdapter(config);
  await adapter.init();
  return adapter;
}
