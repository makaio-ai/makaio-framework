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
  {
    clientId: 'gemini',
    displayName: 'Gemini',
    binaryName: 'gemini',
    detectPaths: ['~/.gemini'],
    extensionPackages: ['@makaio/client-gemini', '@makaio/provider-google', '@makaio/adapter-gemini-sdk'],
  },
  {
    clientId: 'qwen',
    displayName: 'Qwen Code',
    binaryName: 'qwen',
    detectPaths: ['~/.qwen'],
    extensionPackages: ['@makaio/client-qwen', '@makaio/provider-qwen-acp', '@makaio/adapter-qwen-acp'],
  },
  {
    clientId: 'github-copilot',
    displayName: 'GitHub Copilot',
    binaryName: 'copilot',
    detectPaths: ['~/.config/github-copilot'],
    extensionPackages: [
      '@makaio/client-github-copilot',
      '@makaio/provider-github-copilot',
      '@makaio/adapter-github-copilot-sdk',
    ],
  },
];
