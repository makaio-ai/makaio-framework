import type { OpenAINodeAgentConfig } from './types/index.js';
import { OpenAINodeAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { createAdapterConfigFactory } from '@makaio/ai-adapters-core/config';
import { OpenAINodeProviderConfigSchema } from './schemas.js';

export const OpenAINodeConfig = createAdapterConfigFactory<OpenAINodeAgentConfig & { adapterId?: string }>(() => ({
  adapterName: OpenAINodeAdapterName,
  adapterDefaults: {
    reasoningEffort: 'low',
    providerConfig: {},
  },
  schema: OpenAINodeProviderConfigSchema,
  adapterDefinition: { defaultTimeouts: DEFAULT_TIMEOUTS },
}));
