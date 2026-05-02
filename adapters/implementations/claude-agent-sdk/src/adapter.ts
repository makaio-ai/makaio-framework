import { AIAdapter, type AIAdapterConfig } from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import { clientDefinition as claudeClientDefinition } from '@makaio/client-claude-code';

import { ClaudeCodeAgent } from './agent.js';
import { ClaudeSdkConnector } from './connector.js';
import { ClaudeCodeConnectorNamespace, type ClaudeCodeConnectorBus } from './namespace/index.js';
import { ClaudeCodeConfig } from './config.js';
import { ClaudeCodeAdapterName } from './constants.js';
import { createSessionAccountObservationRequester } from './account-observation-requester.js';
import type { ClaudeAgentConfig } from './types/index.js';

export { ClaudeCodeAdapterName };

/**
 * Configuration for Claude Code adapter.
 */
export type ClaudeCodeAdapterConfig = Partial<AIAdapterConfig>;

/**
 * Claude Code Adapter - Domain-level adapter using the three-layer architecture.
 *
 * Architecture:
 * ```
 * ClaudeCodeAdapter extends AIAdapter
 *     -> creates via agentFactory
 * ClaudeCodeAgent extends AIAgent
 *     -> creates via connectorFactory
 * ClaudeSdkConnector extends AIAgentConnector
 * ```
 *
 * Responsibilities:
 * - Handle adapter.startAgent RPC (inherited from AIAdapter)
 * - Create ClaudeCodeAgent instances with proper configuration
 * - Emit adapter.initialized and adapter.session.created events
 * - Manage agent lifecycle (tracking, disposal)
 *
 * MCP integration is handled per-session: each {@link ClaudeConnectorSession}
 * registers itself with the singleton MCP bridge service via
 * `McpSubjects.session.register` on creation and unregisters on teardown.
 *
 * The adapter uses a scoped bus to emit typed events for granular SDK message types:
 * - Assistant content (assistant.text, assistant.thinking, assistant.toolUse, etc.)
 * - User messages (user.text, user.content)
 * - System messages (system.init, system.compactBoundary)
 * - Result messages (result.success, result.error)
 * - Stream events (streamEvent.messageStart, streamEvent.contentBlockDelta, etc.)
 * @example
 * ```typescript
 * // Using the class directly
 * const adapter = new ClaudeCodeAdapter();
 * await adapter.init();
 *
 * // Using the convenience factory
 * const adapter = await createClaudeAdapter();
 *
 * // Subscribe to assistant text content
 * adapter.on(ClaudeCodeSubjects.assistant.text, (payload) => {
 *   console.debug('Text:', payload.block.text);
 * });
 *
 * // Create an agent via startAgent RPC
 * const result = await MakaioBus.request(AdapterSubjects.startAgent, {
 *   adapterId: adapter.adapterId,
 *   mode: 'create',
 *   initialMessage: 'Build a todo app',
 *   model: 'sonnet',
 * });
 * ```
 */
export class ClaudeCodeAdapter extends AIAdapter<ClaudeCodeConnectorBus, ClaudeSdkConnector, ClaudeCodeAgent> {
  public constructor(config?: ClaudeCodeAdapterConfig) {
    const globalBus = config?.globalBus ?? MakaioBus;
    super({
      name: ClaudeCodeAdapterName,
      capabilities: ['tools', 'vision', 'chat:inTurnMessages', 'structuredOutput', 'systemPrompt:override'],
      ...config,
      globalBus,
      namespace: ClaudeCodeConnectorNamespace,
      agentFactory: (agentConfig) => {
        return new ClaudeCodeAgent(agentConfig);
      },
      configFactory: ClaudeCodeConfig.getConfig,
      connectorFactory: (fullConfig) => {
        const agentConfig = fullConfig as ClaudeAgentConfig;
        return new ClaudeSdkConnector({
          ...agentConfig,
          clientId: agentConfig.clientId ?? claudeClientDefinition.id,
          requestSessionAccountObservation: createSessionAccountObservationRequester(globalBus),
          // Extract upstream servers from the resolved MCP session context so they
          // can be baked into the SDK query's mcpServers config alongside the Makaio
          // MCP proxy. The port itself is obtained per-session via bus RPC.
          mcpUpstreamServers: agentConfig.mcpSessionContext?.servers,
        });
      },
      definitionProviders: config?.definitionProviders,
    });
  }
}

/**
 * Factory function to create and initialize a Claude Code adapter.
 *
 * Convenience wrapper that creates the adapter and calls init() for you.
 * @param config - Optional adapter configuration
 * @returns Initialized ClaudeCodeAdapter instance
 * @example
 * ```typescript
 * const adapter = await createClaudeAdapter();
 *
 * // Adapter is ready to handle requests via bus
 * // e.g., MakaioBus.request(AdapterSubjects.startAgent, { adapterId: adapter.adapterId, ... })
 * ```
 */
export async function createClaudeAdapter(config?: ClaudeCodeAdapterConfig): Promise<ClaudeCodeAdapter> {
  const adapter = new ClaudeCodeAdapter(config);
  await adapter.init();
  return adapter;
}
