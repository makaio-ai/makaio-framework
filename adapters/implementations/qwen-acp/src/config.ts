import { createAdapterConfigFactory } from '@makaio/ai-adapters-core/config';
import { QwenAcpAdapterName, DEFAULT_TIMEOUTS } from './constants.js';
import { QwenAcpProviderConfigSchema } from './schemas.js';

/**
 * Config factory for the Qwen ACP adapter.
 *
 * Resolves provider config, credentials, and timeouts from the ProviderConfig
 * entity via the bus. Qwen communicates through the SDK-native Agent Client
 * Protocol subprocess, so it has no HTTP provider endpoint to select.
 */
export const QwenAcpConfig = createAdapterConfigFactory(() => ({
  adapterName: QwenAcpAdapterName,
  adapterDefaults: {},
  schema: QwenAcpProviderConfigSchema,
  adapterDefinition: { defaultTimeouts: DEFAULT_TIMEOUTS },
}));
