import type { CopilotSessionOptions } from './types/index.js';
import { GitHubCopilotSdkAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { createAdapterConfigFactory } from '@makaio/ai-adapters-core/config';
import { GitHubCopilotSdkProviderConfigSchema } from './schemas.js';

export const GitHubCopilotConfig = createAdapterConfigFactory<CopilotSessionOptions & { adapterId?: string }>(() => ({
  adapterName: GitHubCopilotSdkAdapterName,
  adapterDefaults: {
    // Default model sourced from the github-copilot provider definition (framework/providers/github-copilot/src/definition.ts)
    model: 'GPT-5.1-Codex',
  },
  schema: GitHubCopilotSdkProviderConfigSchema,
  adapterDefinition: { defaultTimeouts: DEFAULT_TIMEOUTS },
  // GitHub Copilot communicates via a proprietary SDK; 'openai' is used
  // here as the closest wire protocol for endpoint lookup purposes.
  protocol: 'openai',
}));
