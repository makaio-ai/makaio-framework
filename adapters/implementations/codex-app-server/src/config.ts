import { CodexAppServerAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { createAdapterConfigFactory } from '@makaio/ai-adapters-core/config';
import { CodexAppServerProviderConfigSchema } from './schemas.js';

export const CodexAppServerConfig = createAdapterConfigFactory(() => ({
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
  // Codex communicates via a proprietary subprocess protocol; 'openai' is used
  // here so endpoint lookup works for providers that expose an OpenAI-compatible API.
  protocol: 'openai',
}));
