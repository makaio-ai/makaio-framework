/**
 * Provider IDs and preset configuration for the Anthropic SDK adapter.
 *
 * The Anthropic SDK adapter supports any Anthropic-compatible API.
 * Provider compatibility is declared by stable definition ID — the adapter
 * subsystem resolves each ID to a full ProviderDefinitionInput from the
 * provider registry at boot time.
 *
 * Add new provider IDs here when introducing an Anthropic-compatible provider.
 */
import { defineAdapterProviderAuth, type AdapterProviderAuth } from '@makaio/contracts';

export const providerIds = ['z-ai', 'alibaba', 'opencode-go-anthropic', 'anthropic'] as const;

type ProviderId = (typeof providerIds)[number];

const ANTHROPIC_SDK_AUTH_SCRUB_ENV_VARS = [
  'Z_AI_API_KEY',
  'BAILIAN_CODING_PLAN_API_KEY',
  'OPENCODE_GO_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

/**
 * Define deterministic Anthropic SDK constructor delivery for one provider API key.
 * @param providerDefinitionId - Provider definition that owns the API-key method.
 * @returns Validated adapter/provider authentication metadata.
 */
function defineProviderAuth(providerDefinitionId: ProviderId): AdapterProviderAuth {
  return defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'provider', providerDefinitionId, methodId: 'api-key' },
        deliveries: [
          {
            kind: 'connector',
            target: 'anthropic-sdk.constructor',
            fields: { apiKey: 'apiKey' },
            constants: { authToken: null },
          },
        ],
      },
    ],
    scrubEnvVars: ANTHROPIC_SDK_AUTH_SCRUB_ENV_VARS,
  });
}

/** Validated authentication metadata keyed by supported provider definition ID. */
export const providerAuthById = {
  'z-ai': defineProviderAuth('z-ai'),
  alibaba: defineProviderAuth('alibaba'),
  'opencode-go-anthropic': defineProviderAuth('opencode-go-anthropic'),
  anthropic: defineProviderAuth('anthropic'),
} satisfies Record<ProviderId, AdapterProviderAuth>;

/**
 * Default provider id to use when no provider is explicitly configured.
 *
 * Semantically `anthropic` — the native provider for this adapter.
 */
export const defaultPresetId = 'anthropic';

/**
 * Provider id used for conformance tests.
 *
 * Set to `opencode-go-anthropic` so test runs exercise the Anthropic-compatible
 * OpenCode Go preset without hitting the direct Anthropic API.
 */
export const testPresetId = 'opencode-go-anthropic';
