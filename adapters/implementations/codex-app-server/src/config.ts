import { CodexAppServerAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { createAdapterConfigFactory } from '@makaio/ai-adapters-core/config';
import { CodexAppServerProviderConfigSchema } from './schemas.js';
import type { CodexAppServerConfig as CodexConnectorConfig } from './connector/types.js';

export const CodexAppServerConfig = createAdapterConfigFactory<CodexConnectorConfig>(() => ({
  adapterName: CodexAppServerAdapterName,
  adapterDefaults: {
    reasoningEffort: 'low',
    providerConfig: {
      // 'untrusted' forces approval for non-safe commands (rm, etc.) even in trusted projects
      approvalPolicy: 'untrusted',
      sandboxMode: 'workspace-write',
    },
  },
  schema: CodexAppServerProviderConfigSchema,
  adapterDefinition: { defaultTimeouts: DEFAULT_TIMEOUTS },
}));
