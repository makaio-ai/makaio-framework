/**
 * Adapter definition for Claude Code CLI.
 * Separate file to avoid circular dependency with config.ts.
 */
import type { AIAdapterDefinition } from '@makaio/ai-adapters-core';
import { createClaudeCliAdapter } from './adapter.js';
import { ClaudeCodeCliAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { ClaudeCodeCliProviderConfigSchema } from './schemas.js';
import type { ClaudeCodeCliConnectorBus } from './namespace/index.js';
import type { ClaudeCliConnector } from './connector.js';
import type { ClaudeCodeCliAgent } from './agent.js';
import { defaultPresetId, providerIds } from './provider.js';

/**
 * Adapter definition for the Claude Code CLI adapter.
 *
 * Uses the same model presets as the SDK adapter since both talk to the
 * same Anthropic API — just via a different transport (CLI vs SDK).
 */
export const adapterDefinition: AIAdapterDefinition<ClaudeCodeCliConnectorBus, ClaudeCliConnector, ClaudeCodeCliAgent> =
  {
    name: ClaudeCodeCliAdapterName,
    displayName: 'Claude Code (CLI)',
    defaultPresetId,
    description: 'Claude Code integration via the `claude` CLI binary using stdio JSON streaming',
    providers: providerIds.map((definitionId) => ({ definitionId })),
    providerConfigSchema: ClaudeCodeCliProviderConfigSchema,
    defaultTimeouts: DEFAULT_TIMEOUTS,
    helpLinks: [{ label: 'Claude Code Documentation', url: 'https://docs.anthropic.com/en/docs/claude-code' }],
    clients: [{ id: 'claude-code', version: '^0.1.0' }],
    protocol: 'anthropic',
    instructions: `Claude Code CLI uses the \`claude\` binary for agentic interactions via stdio streaming.

1. Install Claude Code: \`npm install -g @anthropic-ai/claude-code\`
2. Run \`claude auth\` to authenticate
3. Configure your preferred model below`,
    createAdapter: createClaudeCliAdapter,
  };
