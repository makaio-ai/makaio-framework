import type { GeminiConnectorConfig } from './types/index.js';
import { GeminiSdkAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { createAdapterConfigFactory } from '@makaio/ai-adapters-core/config';
import { GeminiSdkProviderConfigSchema } from './schemas.js';

export const GeminiSdkConfig = createAdapterConfigFactory<GeminiConnectorConfig>(() => ({
  adapterName: GeminiSdkAdapterName,
  adapterDefaults: {
    // Default model sourced from the google provider definition (providers/google/src/definition.ts).
    model: 'gemini-2.5-pro',
  },
  schema: GeminiSdkProviderConfigSchema,
  adapterDefinition: { defaultTimeouts: DEFAULT_TIMEOUTS },
}));
