import type { AnthropicSdkAgentConfig } from './types/index.js';
import { AnthropicSdkAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { createAdapterConfigFactory } from '@makaio/ai-adapters-core/config';
import { AnthropicSdkProviderConfigSchema } from './schemas.js';

/**
 * Config factory for the Anthropic SDK adapter.
 *
 * Resolves model, timeouts, and provider config from the ProviderConfig entity
 * via the bus, using the Anthropic wire protocol.
 */
export const AnthropicSdkConfig = createAdapterConfigFactory<AnthropicSdkAgentConfig & { adapterId?: string }>(() => ({
  adapterName: AnthropicSdkAdapterName,
  adapterDefaults: {
    reasoningEffort: 'low',
    providerConfig: {},
  },
  schema: AnthropicSdkProviderConfigSchema,
  adapterDefinition: { defaultTimeouts: DEFAULT_TIMEOUTS },
}));
