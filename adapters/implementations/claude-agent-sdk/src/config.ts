import type { ClaudeAgentConfig } from './types/index.js';
import { ClaudeCodeAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { ClaudeCodeProviderConfigSchema } from './schemas.js';
import { createAdapterConfigFactory } from '@makaio/ai-adapters-core/config';

export const ClaudeCodeConfig = createAdapterConfigFactory<ClaudeAgentConfig>(() => ({
  adapterName: ClaudeCodeAdapterName,
  adapterDefaults: {
    providerConfig: {
      useSdkImmediateMessageMode: false,
      queryOptions: undefined,
    },
  },
  schema: ClaudeCodeProviderConfigSchema,
  adapterDefinition: { defaultTimeouts: DEFAULT_TIMEOUTS },
}));
