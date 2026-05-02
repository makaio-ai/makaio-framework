import type { ProviderDefinition } from '@makaio/contracts';
import { DEVEX_SMOKE_MODEL, DEVEX_SMOKE_PROVIDER_ID, DEVEX_SMOKE_PROVIDER_NAME } from './shared.js';

/**
 * Static provider definition used by the SDK smoke adapter fixture.
 *
 * The fake adapter never performs network I/O, so no protocol endpoints or
 * credentials are required.
 */
export const providerDefinition: ProviderDefinition = {
  id: DEVEX_SMOKE_PROVIDER_ID,
  name: DEVEX_SMOKE_PROVIDER_NAME,
  description: 'Local-only provider used by the CLI SDK smoke test',
  defaultModel: DEVEX_SMOKE_MODEL,
  fastModel: DEVEX_SMOKE_MODEL,
  availableModels: [
    {
      name: DEVEX_SMOKE_MODEL,
      friendlyName: 'Echo Model',
      contextWindowSize: 8_192,
      labId: DEVEX_SMOKE_PROVIDER_ID,
    },
  ],
};
