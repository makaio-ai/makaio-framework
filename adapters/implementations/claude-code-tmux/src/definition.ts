/**
 * Adapter definition for Claude Code tmux.
 *
 * Separate file to avoid circular dependency with config.ts.
 * @packageDocumentation
 */
import type { AIAdapterDefinition } from '@makaio/ai-adapters-core';
import { ADAPTER_NAME, DEFAULT_TIMEOUTS } from './constants.js';
import { ClaudeCodeTmuxProviderConfigSchema } from './schemas.js';
import type { ClaudeCodeTmuxConnectorBus } from './namespace/index.js';
import type { ClaudeCodeTmuxConnector } from './connector.js';
import type { ClaudeCodeTmuxAgent } from './agent.js';
import { defaultPresetId, providerIds } from './provider.js';
import { createClaudeCodeTmuxAdapter } from './adapter.js';

/**
 * Adapter definition for the Claude Code tmux adapter.
 *
 * Runs Claude Code interactively in a tmux session. Orchestration happens
 * through hooks (lifecycle events), MCP (tool bridging), and the tmux pane
 * (user input + visual attach). Same Anthropic API provider compatibility
 * as the CLI adapter.
 */
export const adapterDefinition: AIAdapterDefinition<
  ClaudeCodeTmuxConnectorBus,
  ClaudeCodeTmuxConnector,
  ClaudeCodeTmuxAgent
> = {
  name: ADAPTER_NAME,
  displayName: 'Claude Code (tmux)',
  defaultPresetId,
  description: 'Claude Code integration via interactive tmux sessions with hook-driven orchestration',
  providers: providerIds.map((definitionId) => ({ definitionId })),
  providerConfigSchema: ClaudeCodeTmuxProviderConfigSchema,
  defaultTimeouts: DEFAULT_TIMEOUTS,
  helpLinks: [{ label: 'Claude Code Documentation', url: 'https://docs.anthropic.com/en/docs/claude-code' }],
  clients: [{ id: 'claude-code', version: '^0.1.0', binaryVersion: '>=1.0.0' }],
  protocol: 'anthropic',
  instructions: `Claude Code tmux runs Claude interactively in a tmux session with full terminal access.

1. Install Claude Code: \`npm install -g @anthropic-ai/claude-code\`
2. Install tmux: \`brew install tmux\` (macOS) or \`apt install tmux\` (Linux)
3. Run \`claude auth\` to authenticate
4. Configure your preferred model below`,
  createAdapter: createClaudeCodeTmuxAdapter,
};
