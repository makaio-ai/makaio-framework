/**
 * Adapter definition for Claude Code
 * Separate file to avoid circular dependency with config.ts
 */
import type { AIAdapterDefinition } from '@makaio/ai-adapters-core';
import { createClaudeAdapter } from './adapter.js';
import { ClaudeCodeAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { ClaudeCodeProviderConfigSchema } from './schemas.js';
import type { ClaudeCodeConnectorBus } from './namespace/index.js';
import type { ClaudeSdkConnector } from './connector.js';
import type { ClaudeCodeAgent } from './agent.js';
import { defaultPresetId, providerIds } from './provider.js';

/**
 * Adapter definition for Claude Code.
 *
 * Note: Anthropic provides beta.models.list() API but it only returns model metadata
 * (id, display_name, created_at) without context window sizes. Therefore, we use
 * static provider definitions rather than implementing dynamic fetchModels().
 */
export const adapterDefinition: AIAdapterDefinition<ClaudeCodeConnectorBus, ClaudeSdkConnector, ClaudeCodeAgent> = {
  name: ClaudeCodeAdapterName,
  displayName: 'Claude Code',
  defaultPresetId,
  description: 'Official Claude Code Agent SDK integration',
  providers: providerIds.map((definitionId) => ({ definitionId })),
  providerConfigSchema: ClaudeCodeProviderConfigSchema,
  defaultTimeouts: DEFAULT_TIMEOUTS,
  helpLinks: [{ label: 'Claude Code Documentation', url: 'https://docs.anthropic.com/en/docs/claude-code' }],
  clients: [{ id: 'claude-code', version: '^0.1.0' }],
  protocol: 'anthropic',
  instructions: `Claude Code uses the Claude Agent SDK for agentic interactions. Make sure you have authenticated via the CLI before using.

1. Run \`npx @anthropic-ai/claude-code auth\` to authenticate
2. Configure your preferred model below`,
  createAdapter: createClaudeAdapter,
};
