/**
 * Provider IDs and preset configuration for the Gemini SDK adapter.
 *
 * Provider compatibility is declared by stable definition ID — the adapter
 * subsystem resolves each ID to a full ProviderDefinitionInput from the
 * provider registry at boot time.
 */
import { defineAdapterProviderAuth, type AdapterProviderAuth } from '@makaio/contracts';
import { GEMINI_SDK_SENSITIVE_ENV_VARS } from './gemini-sdk-environment.js';

export const providerIds = ['google'] as const;

type ProviderId = (typeof providerIds)[number];

/** Validated authentication metadata keyed by supported provider definition ID. */
export const providerAuthById = {
  google: defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'provider', providerDefinitionId: 'google', methodId: 'api-key' },
        deliveries: [
          {
            kind: 'connector',
            target: 'gemini-sdk.refresh-auth',
            fields: { apiKey: 'apiKey' },
          },
        ],
      },
    ],
    scrubEnvVars: GEMINI_SDK_SENSITIVE_ENV_VARS,
  }),
} satisfies Record<ProviderId, AdapterProviderAuth>;

/**
 * Default provider id to use when no provider is explicitly configured.
 */
export const defaultPresetId = 'google';

/** Provider id used for conformance tests (same as host default for this adapter). */
export const testPresetId: string = defaultPresetId;
