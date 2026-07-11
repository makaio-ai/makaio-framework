import { createAdapterConfigFactory } from '@makaio/ai-adapters-core/config';
import { PiSdkAdapterName, DEFAULT_TIMEOUTS, DefaultModel } from './constants.js';
import { PiSdkProviderConfigSchema } from './schemas.js';

/**
 * Config factory for the Pi SDK adapter.
 *
 * Resolves provider config, credentials, and timeouts from the ProviderConfig
 * entity via the bus. Pi SDK defaults to Anthropic-compatible Claude models,
 * while the connector still resolves concrete provider endpoints from the
 * selected provider context at runtime.
 *
 * Model names are passed through verbatim — Pi uses the same identifiers that
 * Makaio uses (e.g., `claude-sonnet-4-6`).
 */
export const PiSdkConfig = createAdapterConfigFactory(() => ({
  adapterName: PiSdkAdapterName,
  adapterDefaults: { model: DefaultModel },
  schema: PiSdkProviderConfigSchema,
  adapterDefinition: { defaultTimeouts: DEFAULT_TIMEOUTS },
}));
