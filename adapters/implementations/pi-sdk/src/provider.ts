/**
 * Provider IDs and preset configuration for the Pi SDK adapter.
 *
 * Pi SDK routes internally to the configured provider using each provider's
 * native API keys and endpoints. Provider compatibility is declared by stable
 * definition ID; the adapter subsystem resolves each ID to a full provider
 * definition from active provider extensions at boot time.
 *
 * Supported providers:
 * - `anthropic`: Official Anthropic Claude API (ANTHROPIC_API_KEY)
 * - `openai`: Official OpenAI API (OPENAI_API_KEY)
 * - `opencode-go`: OpenCode Go gateway — OpenAI compatible (OPENCODE_GO_API_KEY)
 *
 * Pi SDK natively supports additional providers (Google, etc.) which can be
 * added here as needed.
 */
import { defineAdapterProviderAuth, type AdapterProviderAuth } from '@makaio/contracts';

export const providerIds = ['anthropic', 'openai', 'opencode-go'] as const;

type ProviderId = (typeof providerIds)[number];

const PI_SDK_AUTH_SCRUB_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENCODE_GO_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_ADMIN_KEY',
] as const;

/**
 * Define Pi provider-auth delivery for one provider API key.
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
            target: 'pi-sdk.provider-auth',
            fields: { apiKey: 'apiKey' },
          },
        ],
      },
    ],
    scrubEnvVars: PI_SDK_AUTH_SCRUB_ENV_VARS,
  });
}

/** Validated authentication metadata keyed by supported provider definition ID. */
export const providerAuthById = {
  anthropic: defineProviderAuth('anthropic'),
  openai: defineProviderAuth('openai'),
  'opencode-go': defineProviderAuth('opencode-go'),
} satisfies Record<ProviderId, AdapterProviderAuth>;

/**
 * Default provider id to use when no provider is explicitly configured.
 *
 * Anthropic is the default because Pi SDK was originally built around Claude
 * and `claude-sonnet-4-6` is the default model.
 */
export const defaultPresetId = 'anthropic';

/**
 * Provider id used for conformance tests.
 *
 * Set to `opencode-go` (OpenCode Go gateway) to avoid expensive direct API
 * calls during test runs while still exercising the full provider registration
 * and credential resolution flow.
 */
export const testPresetId = 'opencode-go';
