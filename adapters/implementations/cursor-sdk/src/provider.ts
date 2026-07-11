/**
 * Provider IDs and preset configuration for the Cursor SDK adapter.
 *
 * The Cursor SDK authenticates directly against Cursor's proprietary Composer API
 * using a cursor-specific credential type. Provider compatibility is declared by
 * stable definition ID; the adapter subsystem resolves each ID to a full provider
 * definition from active provider extensions at boot time.
 *
 * Supported providers:
 * - `cursor`: Cursor AI editor (CURSOR_API_KEY)
 */
import { defineAdapterProviderAuth, type AdapterProviderAuth } from '@makaio/contracts';

export const providerIds = ['cursor'] as const;

type ProviderId = (typeof providerIds)[number];

/** Validated authentication metadata keyed by supported provider definition ID. */
export const providerAuthById = {
  cursor: defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'provider', providerDefinitionId: 'cursor', methodId: 'api-key' },
        deliveries: [
          {
            kind: 'connector',
            target: 'cursor-sdk.agent-create',
            fields: { apiKey: 'apiKey' },
          },
        ],
      },
    ],
    scrubEnvVars: ['CURSOR_API_KEY'],
  }),
} satisfies Record<ProviderId, AdapterProviderAuth>;

/**
 * Default provider id to use when no provider is explicitly configured.
 *
 * Cursor is the only supported provider for this adapter.
 */
export const defaultPresetId = 'cursor';

/**
 * Provider id used for conformance tests.
 *
 * Set to `cursor` as this adapter only supports the Cursor provider.
 */
export const testPresetId = 'cursor';
