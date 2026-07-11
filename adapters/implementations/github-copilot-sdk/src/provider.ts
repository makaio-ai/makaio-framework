/**
 * Provider IDs and preset configuration for the GitHub Copilot SDK adapter.
 *
 * Provider compatibility is declared by stable definition ID — the adapter
 * subsystem resolves each ID to a full ProviderDefinitionInput from the
 * provider registry at boot time. Edit provider packages and registry YAML, not
 * generated artifacts.
 *
 * Note: GitHub Copilot SDK does not expose a models listing API,
 * so models are configured statically in the provider package.
 */
import { defineAdapterProviderAuth, type AdapterProviderAuth } from '@makaio/contracts';

export const providerIds = ['github-copilot'] as const;

type ProviderId = (typeof providerIds)[number];

/** Validated authentication metadata keyed by supported provider definition ID. */
export const providerAuthById = {
  'github-copilot': defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'provider', providerDefinitionId: 'github-copilot', methodId: 'token' },
        deliveries: [
          {
            kind: 'connector',
            target: 'github-copilot-sdk.constructor',
            fields: { token: 'githubToken' },
          },
        ],
      },
    ],
    scrubEnvVars: [
      'COPILOT_TOKEN',
      'COPILOT_SDK_AUTH_TOKEN',
      'COPILOT_GITHUB_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GITHUB_COPILOT_API_TOKEN',
    ],
  }),
} satisfies Record<ProviderId, AdapterProviderAuth>;

/**
 * Default provider id to use when no provider is explicitly configured.
 */
export const defaultPresetId = 'github-copilot';

/** Provider id used for conformance tests (same as host default for this adapter). */
export const testPresetId: string = defaultPresetId;
