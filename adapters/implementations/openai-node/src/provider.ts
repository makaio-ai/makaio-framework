/**
 * Provider IDs and preset configuration for the OpenAI Node adapter.
 *
 * The OpenAI adapter supports any OpenAI-compatible API.
 * Provider compatibility is declared by stable definition ID — the adapter
 * subsystem resolves each ID to a full ProviderDefinitionInput from the
 * provider registry at boot time.
 *
 * Add new provider IDs here when introducing an OpenAI-compatible provider.
 */
import { defineAdapterProviderAuth, type AdapterProviderAuth } from '@makaio/contracts';

export const providerIds = ['openai', 'nanogpt', 'openrouter', 'z-ai', 'alibaba', 'opencode-go'] as const;

type ProviderId = (typeof providerIds)[number];

const OPENAI_NODE_AUTH_SCRUB_ENV_VARS = [
  'OPENAI_API_KEY',
  'NANOGPT_API_KEY',
  'OPENROUTER_API_KEY',
  'Z_AI_API_KEY',
  'BAILIAN_CODING_PLAN_API_KEY',
  'OPENCODE_GO_API_KEY',
  'OPENAI_ADMIN_KEY',
] as const;

/**
 * Define deterministic OpenAI constructor delivery for one provider API key.
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
            target: 'openai-node.constructor',
            fields: { apiKey: 'apiKey' },
            constants: { adminAPIKey: null },
          },
        ],
      },
    ],
    scrubEnvVars: OPENAI_NODE_AUTH_SCRUB_ENV_VARS,
  });
}

/** Validated authentication metadata keyed by supported provider definition ID. */
export const providerAuthById = {
  openai: defineProviderAuth('openai'),
  nanogpt: defineProviderAuth('nanogpt'),
  openrouter: defineProviderAuth('openrouter'),
  'z-ai': defineProviderAuth('z-ai'),
  alibaba: defineProviderAuth('alibaba'),
  'opencode-go': defineProviderAuth('opencode-go'),
} satisfies Record<ProviderId, AdapterProviderAuth>;

/**
 * Default provider id to use when no provider is explicitly configured.
 *
 * Semantically `openai` — the native provider for this adapter.
 */
export const defaultPresetId = 'openai';

/**
 * Provider id used for conformance tests.
 *
 * Set to `opencode-go` (OpenCode Go gateway) to avoid expensive OpenAI API
 * calls during test runs while still exercising the OpenAI-compatible wire protocol.
 */
export const testPresetId = 'opencode-go';
