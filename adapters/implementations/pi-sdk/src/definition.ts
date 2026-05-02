/**
 * Adapter definition for Pi SDK.
 * Separate file to avoid circular dependency with config.ts.
 */
import type { AIAdapterDefinition } from '@makaio/ai-adapters-core';
import { createPiSdkAdapter } from './adapter.js';
import { PiSdkAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { PiSdkProviderConfigSchema } from './schemas.js';
import type { PiSdkBus } from './namespaces/index.js';
import type { PiConnector } from './connector.js';
import type { PiAgent } from './agent.js';
import { defaultPresetId, providerIds } from './provider.js';

export const adapterDefinition: AIAdapterDefinition<PiSdkBus, PiConnector, PiAgent> = {
  name: PiSdkAdapterName,
  displayName: 'Pi SDK',
  defaultPresetId,
  description: 'Pi coding agent SDK wrapper',
  providers: providerIds.map((definitionId) => ({ definitionId })),
  providerConfigSchema: PiSdkProviderConfigSchema,
  defaultTimeouts: DEFAULT_TIMEOUTS,
  helpLinks: [],
  instructions:
    'Install the Pi coding agent SDK and ensure `@mariozechner/pi-coding-agent` is available as a peer dependency.',
  protocol: 'anthropic',
  createAdapter: createPiSdkAdapter,
};
