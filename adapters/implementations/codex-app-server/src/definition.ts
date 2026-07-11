/**
 * Adapter definition for Codex App-Server
 * Separate file to avoid circular dependency with config.ts
 */
import type { AIAdapterDefinition } from '@makaio/ai-adapters-core';
import { createCodexAppServerAdapter } from './adapter.js';
import { CodexAppServerAdapterName, DEFAULT_TIMEOUTS, DefaultModel } from './constants.js';
import { CodexAppServerProviderConfigSchema } from './schemas.js';
import type { CodexAppServerBus } from './namespaces/index.js';
import type { CodexAppServerConnector } from './connector.js';
import type { CodexAppServerAgent } from './agent.js';
import { defaultPresetId, providerAuthById, providerIds } from './provider.js';

export const adapterDefinition: AIAdapterDefinition<CodexAppServerBus, CodexAppServerConnector, CodexAppServerAgent> = {
  name: CodexAppServerAdapterName,
  displayName: 'Codex App-Server',
  defaultPresetId,
  description: 'Direct integration with codex app-server via stdio subprocess using JSON-RPC 2.0 over JSONL',
  providers: providerIds.map((definitionId) => ({
    definitionId,
    protocol: 'openai',
    auth: providerAuthById[definitionId],
  })),
  providerConfigSchema: CodexAppServerProviderConfigSchema,
  defaultTimeouts: DEFAULT_TIMEOUTS,
  helpLinks: [{ label: 'Codex App Server', url: 'https://developers.openai.com/codex/app-server/' }],
  clients: [{ id: 'codex', version: '^0.1.0' }],
  protocol: 'openai',
  instructions: `Codex App-Server provides direct integration with the codex app-server via stdio subprocess.

## Prerequisites

1. Install the Codex CLI using the official Codex documentation.

2. Verify the installation:
   \`codex --version\`

## Configuration

- **Working Directory (cwd)**: Required - The directory where codex app-server will run
- **Model**: Optional - Codex model to use (default: ${DefaultModel})
- **Reasoning Effort**: Optional - Set reasoning level (low/medium/high)
- **Approval Policy**: Optional - Control tool execution approval (never/always/auto)
- **Sandbox Mode**: Optional - Command execution sandbox (none/docker/vm)

## Usage

The adapter spawns a \`codex app-server\` subprocess and communicates via stdin/stdout using JSON-RPC 2.0 over JSONL.

Native tools:
- \`bash\`: Execute shell commands
- \`patch\`: Apply file changes`,
  createAdapter: createCodexAppServerAdapter,
};
