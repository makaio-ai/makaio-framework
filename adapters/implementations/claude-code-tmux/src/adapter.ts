/**
 * ClaudeCodeTmuxAdapter — domain-level adapter using the three-layer architecture.
 *
 * ```
 * ClaudeCodeTmuxAdapter extends AIAdapter
 *     → creates via agentFactory
 * ClaudeCodeTmuxAgent extends AIAgent
 *     → creates via connectorFactory
 * ClaudeCodeTmuxConnector extends AIAgentConnector
 * ```
 *
 * Transport:
 * Each agent spawns a persistent Claude Code process in a tmux pane.
 * Lifecycle events flow through Claude Code hooks (SessionStart, PreToolUse,
 * PostToolUse, Stop) rather than JSONL parsing. Multi-turn context is managed
 * by Claude Code's own session. Tool approval is handled via PreToolUse hooks.
 * @packageDocumentation
 */

import { AIAdapter, type AIAdapterConfig } from '@makaio/ai-adapters-core';
import { ClaudeCodeTmuxAgent } from './agent.js';
import { ClaudeCodeTmuxConnector } from './connector.js';
import { ClaudeCodeTmuxConnectorNamespace, type ClaudeCodeTmuxConnectorBus } from './namespace/index.js';
import { ClaudeCodeTmuxConfig } from './config.js';
import { ADAPTER_NAME } from './constants.js';
import type { ClaudeCodeTmuxAgentConfig } from './types.js';
import type { ClaudeCodeTmuxProviderConfig } from './schemas.js';

/**
 * Configuration for the Claude Code tmux adapter.
 */
export type ClaudeCodeTmuxAdapterConfig = Partial<AIAdapterConfig> & {
  /**
   * Adapter-scoped provider defaults merged into each agent config.
   *
   * Runtime provider config wins over these defaults. Test hosts use this to
   * isolate spawned tmux sessions without changing production defaults.
   */
  providerConfigDefaults?: Partial<ClaudeCodeTmuxProviderConfig>;
};

/**
 * Claude Code tmux adapter.
 *
 * Responsibilities:
 * - Handle adapter.startAgent RPC (inherited from AIAdapter)
 * - Create ClaudeCodeTmuxAgent instances with proper configuration
 * - Manage agent lifecycle (tracking, disposal)
 */
export class ClaudeCodeTmuxAdapter extends AIAdapter<
  ClaudeCodeTmuxConnectorBus,
  ClaudeCodeTmuxConnector,
  ClaudeCodeTmuxAgent
> {
  /**
   * Create a Claude Code tmux adapter with optional runtime overrides.
   * @param config - Optional adapter configuration overrides merged with tmux defaults.
   */
  public constructor(config?: ClaudeCodeTmuxAdapterConfig) {
    const { providerConfigDefaults, ...adapterConfig } = config ?? {};
    super({
      name: ADAPTER_NAME,
      capabilities: ['tools', 'systemPrompt:override', 'systemPrompt:append'],
      ...adapterConfig,
      namespace: ClaudeCodeTmuxConnectorNamespace,
      agentFactory: (agentConfig) => new ClaudeCodeTmuxAgent(agentConfig),
      configFactory: async (input) => {
        const resolved = await ClaudeCodeTmuxConfig.getConfig(input);
        if (!providerConfigDefaults) {
          return resolved;
        }
        return {
          ...resolved,
          providerConfig: {
            ...providerConfigDefaults,
            ...resolved.providerConfig,
          },
        };
      },
      connectorFactory: (fullConfig) => {
        const typedConfig = fullConfig as ClaudeCodeTmuxAgentConfig;
        return new ClaudeCodeTmuxConnector({
          ...typedConfig,
          mcpUpstreamServers: typedConfig.mcpSessionContext?.servers,
        });
      },
      definitionProviders: adapterConfig.definitionProviders,
    });
  }
}

/**
 * Factory function to create and initialize a Claude Code tmux adapter.
 * @param config - Optional adapter configuration
 * @returns Initialized ClaudeCodeTmuxAdapter instance
 */
export async function createClaudeCodeTmuxAdapter(
  config?: ClaudeCodeTmuxAdapterConfig,
): Promise<ClaudeCodeTmuxAdapter> {
  const adapter = new ClaudeCodeTmuxAdapter(config);
  await adapter.init();
  return adapter;
}
