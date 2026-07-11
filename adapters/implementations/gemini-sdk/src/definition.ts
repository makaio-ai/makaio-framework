/**
 * Adapter definition for Gemini SDK
 * Separate file to avoid circular dependency with config.ts
 */
import type { AIAdapterDefinition } from '@makaio/ai-adapters-core';
import { createGeminiSDKAdapter } from './adapter.js';
import { GeminiSdkAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { GeminiSdkProviderConfigSchema } from './schemas.js';
import type { GeminiConnectorBus } from './namespaces/index.js';
import type { GeminiConnector } from './connector.js';
import type { GeminiAgent } from './agent.js';
import { defaultPresetId, providerAuthById, providerIds } from './provider.js';

export const adapterDefinition: AIAdapterDefinition<GeminiConnectorBus, GeminiConnector, GeminiAgent> = {
  name: GeminiSdkAdapterName,
  displayName: 'Gemini SDK',
  defaultPresetId,
  clients: [{ id: 'gemini', version: '^0.1.0' }],
  description: 'Google Gemini SDK integration',
  providers: providerIds.map((definitionId) => ({ definitionId, auth: providerAuthById[definitionId] })),
  providerConfigSchema: GeminiSdkProviderConfigSchema,
  defaultTimeouts: DEFAULT_TIMEOUTS,
  helpLinks: [{ label: 'Gemini Documentation', url: 'https://ai.google.dev/docs' }],
  instructions: `Configure Gemini for use with Google AI models.

1. Set up authentication via [Google AI Studio](https://ai.google.dev/)
2. Optionally enable debug mode for troubleshooting
3. Configure checkpointing for session persistence`,
  createAdapter: createGeminiSDKAdapter,
};
