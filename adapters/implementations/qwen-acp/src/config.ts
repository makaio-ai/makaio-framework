import { createAdapterConfigFactory } from '@makaio/ai-adapters-core/config';
import { QwenAcpAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { QwenAcpProviderConfigSchema } from './schemas.js';

/**
 * Config factory for the Qwen ACP adapter.
 *
 * Resolves provider config, credentials, and timeouts from the ProviderConfig
 * entity via the bus. Qwen communicates via the Agent Client Protocol (ACP)
 * subprocess; 'openai' is used here as the closest wire protocol for endpoint
 * lookup purposes.
 */
export const QwenAcpConfig = createAdapterConfigFactory(() => ({
  adapterName: QwenAcpAdapterName,
  adapterDefaults: {},
  schema: QwenAcpProviderConfigSchema,
  adapterDefinition: { defaultTimeouts: DEFAULT_TIMEOUTS },
  protocol: 'openai',
}));
