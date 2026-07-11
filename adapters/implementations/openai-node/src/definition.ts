/**
 * Adapter definition for OpenAI Node
 * Separate file to avoid circular dependency with config.ts
 */
import type { AIAdapterDefinition } from '@makaio/ai-adapters-core';
import { createOpenAINodeAdapter } from './adapter.js';
import { OpenAINodeAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { OpenAINodeProviderConfigSchema } from './schemas.js';
import type { OpenAINodeConnectorBus } from './namespaces/index.js';
import type { OpenAINodeConnector } from './connector.js';
import type { OpenAIAgent } from './agent.js';
import { defaultPresetId, providerAuthById, providerIds } from './provider.js';

export const adapterDefinition: AIAdapterDefinition<OpenAINodeConnectorBus, OpenAINodeConnector, OpenAIAgent> = {
  name: OpenAINodeAdapterName,
  displayName: 'OpenAI',
  defaultPresetId,
  description: 'OpenAI chat completions with streaming and tool calling',
  providers: providerIds.map((definitionId) => ({
    definitionId,
    protocol: 'openai',
    auth: providerAuthById[definitionId],
  })),
  providerConfigSchema: OpenAINodeProviderConfigSchema,
  defaultTimeouts: DEFAULT_TIMEOUTS,
  helpLinks: [{ label: 'OpenAI API Documentation', url: 'https://platform.openai.com/docs' }],
  instructions: `To use OpenAI, you need an API key:

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Create a new API key
3. Copy and paste it below

> **Tip:** Use \`keychain:openai:api-key\` to store securely in your system keychain.`,
  protocol: 'openai',
  createAdapter: createOpenAINodeAdapter,
};
