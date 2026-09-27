import type { SetupClientEntry } from '../types.js';

/**
 * Static catalog of known AI clients that Makaio can integrate with.
 * Order determines display priority in the setup flow.
 */
export const CLIENT_CATALOG: readonly SetupClientEntry[] = [
  {
    clientId: 'claude-code',
    displayName: 'Claude Code',
    binaryName: 'claude',
    detectPaths: ['~/.claude'],
    extensionPackages: ['@makaio/client-claude-code', '@makaio/provider-anthropic', '@makaio/adapter-claude-agent-sdk'],
  },
  {
    clientId: 'codex',
    displayName: 'Codex',
    binaryName: 'codex',
    detectPaths: ['~/.codex'],
    extensionPackages: ['@makaio/client-codex', '@makaio/provider-openai', '@makaio/adapter-codex-app-server'],
  },
];
