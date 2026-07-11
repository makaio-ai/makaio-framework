import type { ClaudeCodeTmuxAgentConfig } from './types.js';
import { ADAPTER_NAME, DEFAULT_TIMEOUTS } from './constants.js';
import { ClaudeCodeTmuxProviderConfigSchema } from './schemas.js';
import { createAdapterConfigFactory } from '@makaio/ai-adapters-core/config';

/** Adapter config factory for the Claude Code tmux adapter. */
export const ClaudeCodeTmuxConfig = createAdapterConfigFactory<ClaudeCodeTmuxAgentConfig>(() => ({
  adapterName: ADAPTER_NAME,
  adapterDefaults: {
    providerConfig: { skipPermissions: true },
  },
  schema: ClaudeCodeTmuxProviderConfigSchema,
  adapterDefinition: { defaultTimeouts: DEFAULT_TIMEOUTS },
}));
