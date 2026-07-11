/**
 * Provider IDs and preset configuration for the Codex App-Server adapter.
 *
 * Provider compatibility is declared by stable definition ID — the adapter
 * subsystem resolves each ID to a full ProviderDefinitionInput from the
 * provider registry at boot time.
 */
import { defineAdapterProviderAuth, type AdapterProviderAuth } from '@makaio/contracts';

export const providerIds = ['openai-codex'] as const;

type ProviderId = (typeof providerIds)[number];

/** Validated authentication metadata keyed by supported provider definition ID. */
export const providerAuthById = {
  'openai-codex': defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'client', clientId: 'codex', methodId: 'native' },
        deliveries: [{ kind: 'native-client', clientId: 'codex' }],
      },
      {
        method: { owner: 'client', clientId: 'codex', methodId: 'access-token' },
        deliveries: [{ kind: 'process-env', fields: { accessToken: 'CODEX_ACCESS_TOKEN' } }],
      },
      {
        method: { owner: 'provider', providerDefinitionId: 'openai-codex', methodId: 'api-key' },
        deliveries: [
          {
            kind: 'connector',
            target: 'codex.account-login.api-key',
            fields: { apiKey: 'apiKey' },
            constants: { type: 'apiKey' },
          },
        ],
      },
    ],
    scrubEnvVars: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
  }),
} satisfies Record<ProviderId, AdapterProviderAuth>;

/**
 * Default provider id to use when no provider is explicitly configured.
 */
export const defaultPresetId = 'openai-codex';

/** Provider id used for conformance tests (same as host default for this adapter). */
export const testPresetId: string = defaultPresetId;
