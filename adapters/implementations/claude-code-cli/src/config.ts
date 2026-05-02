import type { ClaudeCliAgentConfig } from './types.js';
import { ClaudeCodeCliAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { ClaudeCodeCliProviderConfigSchema } from './schemas.js';
import { createAdapterConfigFactory } from '@makaio/ai-adapters-core/config';

export const ClaudeCodeCliConfig = createAdapterConfigFactory<ClaudeCliAgentConfig>(() => ({
  adapterName: ClaudeCodeCliAdapterName,
  adapterDefaults: {
    providerConfig: {},
  },
  schema: ClaudeCodeCliProviderConfigSchema,
  adapterDefinition: { defaultTimeouts: DEFAULT_TIMEOUTS },
  protocol: 'anthropic',
}));
