import { createAdapterConfigFactory } from '@makaio/ai-adapters-core/config';
import { CursorSdkAdapterName, DefaultModel, DEFAULT_TIMEOUTS } from './constants.js';
import { CursorSdkProviderConfigSchema } from './schemas.js';

/**
 * Config factory for the Cursor SDK adapter.
 *
 * Resolves provider config, credentials, and timeouts from the ProviderConfig
 * entity via the bus. Cursor SDK uses its own Composer transport and has no
 * Makaio-standard wire protocol or protocol endpoint override.
 *
 * Model names are passed through verbatim to the Cursor Agent constructor.
 */
export const CursorSdkConfig = createAdapterConfigFactory(() => ({
  adapterName: CursorSdkAdapterName,
  adapterDefaults: { model: DefaultModel },
  schema: CursorSdkProviderConfigSchema,
  adapterDefinition: { defaultTimeouts: DEFAULT_TIMEOUTS },
}));
