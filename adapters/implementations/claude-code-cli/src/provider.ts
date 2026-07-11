/**
 * Provider IDs and preset configuration for the Claude Code CLI adapter.
 *
 * Provider compatibility is declared by stable definition ID — the adapter
 * subsystem resolves each ID to a full ProviderDefinitionInput from the
 * provider registry at boot time.
 */
import { defineAdapterProviderAuth, type AdapterProviderAuth } from '@makaio/contracts';

export const providerIds = ['anthropic', 'anthropic-oauth', 'opencode-go-anthropic'] as const;

type ProviderId = (typeof providerIds)[number];
type ApiKeyProviderId = Exclude<ProviderId, 'anthropic-oauth'>;

const CLAUDE_CODE_CLI_AUTH_SCRUB_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENCODE_GO_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_AWS_API_KEY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
] as const;

/**
 * Define Claude Code process delivery for a provider-owned API key.
 * @param providerDefinitionId - Provider definition that owns the API-key method.
 * @returns Validated adapter/provider authentication metadata.
 */
function defineProviderApiKeyAuth(providerDefinitionId: ApiKeyProviderId): AdapterProviderAuth {
  return defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'provider', providerDefinitionId, methodId: 'api-key' },
        deliveries: [{ kind: 'process-env', fields: { apiKey: 'ANTHROPIC_API_KEY' } }],
      },
    ],
    scrubEnvVars: CLAUDE_CODE_CLI_AUTH_SCRUB_ENV_VARS,
  });
}

/** Validated authentication metadata keyed by supported provider definition ID. */
export const providerAuthById = {
  anthropic: defineProviderApiKeyAuth('anthropic'),
  'anthropic-oauth': defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
        deliveries: [{ kind: 'native-client', clientId: 'claude-code' }],
      },
      {
        method: { owner: 'client', clientId: 'claude-code', methodId: 'oauth-token' },
        deliveries: [{ kind: 'process-env', fields: { oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN' } }],
      },
    ],
    scrubEnvVars: CLAUDE_CODE_CLI_AUTH_SCRUB_ENV_VARS,
  }),
  'opencode-go-anthropic': defineProviderApiKeyAuth('opencode-go-anthropic'),
} satisfies Record<ProviderId, AdapterProviderAuth>;

/**
 * Default provider id to use when no provider is explicitly configured.
 */
export const defaultPresetId = 'anthropic';

/** Provider id used for conformance tests through the Claude Code client auth context. */
export const testPresetId: (typeof providerIds)[number] = 'anthropic-oauth';
