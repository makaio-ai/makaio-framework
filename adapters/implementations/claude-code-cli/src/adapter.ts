import { AIAdapter, type AIAdapterConfig } from '@makaio/ai-adapters-core';

import { ClaudeCodeCliAgent } from './agent.js';
import { ClaudeCliConnector } from './connector.js';
import { ClaudeCodeCliConnectorNamespace, type ClaudeCodeCliConnectorBus } from './namespace/index.js';
import { ClaudeCodeCliConfig } from './config.js';
import { ClaudeCodeCliAdapterName } from './constants.js';
import type { ClaudeCliAgentConfig } from './types.js';

export { ClaudeCodeCliAdapterName };

/**
 * Configuration for the Claude Code CLI adapter.
 */
export type ClaudeCodeCliAdapterConfig = Partial<AIAdapterConfig>;

/**
 * Claude Code CLI Adapter - Domain-level adapter using the three-layer architecture.
 *
 * Architecture:
 * ```
 * ClaudeCodeCliAdapter extends AIAdapter
 *     -> creates via agentFactory
 * ClaudeCodeCliAgent extends AIAgent
 *     -> creates via connectorFactory
 * ClaudeCliConnector extends AIAgentConnector
 * ```
 *
 * Responsibilities:
 * - Handle adapter.startAgent RPC (inherited from AIAdapter)
 * - Create ClaudeCodeCliAgent instances with proper configuration
 * - Emit adapter.initialized and adapter.session.created events
 * - Manage agent lifecycle (tracking, disposal)
 *
 * Transport:
 * Each turn spawns `claude -p --output-format stream-json` and parses JSONL
 * from stdout. Multi-turn context is preserved server-side via `--resume`.
 * Permission prompts are handled via `--permission-prompt-tool mcp__makaio__approve`
 * through the singleton HTTP MCP server managed by McpServerBridgeService.
 * The session registers with the bridge via `McpSubjects.session.register` RPC
 * before each turn and unregisters after.
 */
export class ClaudeCodeCliAdapter extends AIAdapter<ClaudeCodeCliConnectorBus, ClaudeCliConnector, ClaudeCodeCliAgent> {
  /**
   * Create a Claude Code CLI adapter with optional runtime overrides.
   * @param config - Optional adapter configuration overrides (for example custom `definitionProviders`)
   * merged with Claude Code CLI defaults.
   */
  public constructor(config?: ClaudeCodeCliAdapterConfig) {
    super({
      name: ClaudeCodeCliAdapterName,
      capabilities: ['tools', 'chatInTurnMessages', 'systemPrompt:override', 'systemPrompt:append'],
      ...config,
      namespace: ClaudeCodeCliConnectorNamespace,
      agentFactory: (agentConfig) => new ClaudeCodeCliAgent(agentConfig),
      configFactory: ClaudeCodeCliConfig.getConfig,
      connectorFactory: (fullConfig) => {
        const typedConfig = fullConfig as ClaudeCliAgentConfig;
        return new ClaudeCliConnector({
          ...typedConfig,
          mcpUpstreamServers: typedConfig.mcpSessionContext?.servers,
        });
      },
      definitionProviders: config?.definitionProviders,
    });
  }
}

/**
 * Factory function to create and initialize a Claude Code CLI adapter.
 * @param config - Optional adapter configuration
 * @returns Initialized ClaudeCodeCliAdapter instance
 */
export async function createClaudeCliAdapter(config?: ClaudeCodeCliAdapterConfig): Promise<ClaudeCodeCliAdapter> {
  const adapter = new ClaudeCodeCliAdapter(config);
  await adapter.init();
  return adapter;
}
