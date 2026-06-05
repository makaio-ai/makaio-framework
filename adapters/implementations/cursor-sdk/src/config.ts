import { createAdapterConfigFactory } from '@makaio/ai-adapters-core/config';
import { CursorSdkAdapterName, DefaultModel, DEFAULT_TIMEOUTS } from './constants.js';
import { CursorSdkProviderConfigSchema } from './schemas.js';

/**
 * Config factory for the Cursor SDK adapter.
 *
 * Resolves provider config, credentials, and timeouts from the ProviderConfig
 * entity via the bus. Cursor SDK uses its own Composer API endpoint and has no
 * Makaio-standard wire protocol. The `protocol` field is set to `'openai'`
 * only to satisfy the required `ProtocolId` constraint.
 *
 * Model names are passed through verbatim to the Cursor Agent constructor.
 */
export const CursorSdkConfig = createAdapterConfigFactory(() => ({
  adapterName: CursorSdkAdapterName,
  adapterDefaults: { model: DefaultModel },
  schema: CursorSdkProviderConfigSchema,
  adapterDefinition: { defaultTimeouts: DEFAULT_TIMEOUTS },
  // Cursor SDK uses its own Composer API — it has no standard Makaio wire protocol.
  // 'openai' is supplied only to satisfy the required ProtocolId constraint; Cursor's
  // connector resolves its own authentication independently and does not use
  // endpointOverrides from the provider context.
  protocol: 'openai',
}));
