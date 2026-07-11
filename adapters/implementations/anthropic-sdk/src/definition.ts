/**
 * Adapter definition for Anthropic SDK.
 * Separate file to avoid circular dependency with config.ts.
 */
import type { AIAdapterDefinition } from '@makaio/ai-adapters-core';
import { createAnthropicSdkAdapter } from './adapter.js';
import { AnthropicSdkAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { AnthropicSdkProviderConfigSchema } from './schemas.js';
import { defaultPresetId, providerAuthById, providerIds } from './provider.js';
import type { AnthropicSdkConnectorBus } from './namespaces/index.js';
import type { AnthropicSdkConnector } from './connector.js';
import type { AnthropicSdkAgent } from './agent.js';

export const adapterDefinition: AIAdapterDefinition<
  AnthropicSdkConnectorBus,
  AnthropicSdkConnector,
  AnthropicSdkAgent
> = {
  name: AnthropicSdkAdapterName,
  displayName: 'Anthropic SDK',
  defaultPresetId,
  description: 'Anthropic Messages API with streaming, tool calling, and extended thinking',
  providers: providerIds.map((definitionId) => ({
    definitionId,
    protocol: 'anthropic',
    auth: providerAuthById[definitionId],
  })),
  providerConfigSchema: AnthropicSdkProviderConfigSchema,
  defaultTimeouts: DEFAULT_TIMEOUTS,
  helpLinks: [
    { label: 'Anthropic API Documentation', url: 'https://docs.anthropic.com/en/api' },
    { label: 'API Keys', url: 'https://console.anthropic.com/settings/keys' },
  ],
  instructions: `To use Anthropic directly, you need an API key:

1. Go to [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Create a new API key
3. Copy and paste it below

> **Tip:** Use \`keychain:anthropic:api-key\` to store securely in your system keychain.

Alternatively, select the **Z.ai** preset to use the Z.ai Anthropic-compatible proxy with your Z.ai API key.`,
  protocol: 'anthropic',
  createAdapter: createAnthropicSdkAdapter,
};
